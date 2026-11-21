import { execFile, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, readdir, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  isValidAgentId,
  type AgentKind,
  type AgentStatus,
  type RunOutcome,
} from "@agent-hand/bantou-protocol";
import type { Config } from "./config";
import { assertModel, readModelRecord, writeModelRecord, type WithModel } from "./model";
import { killGroup, type ClaudeRunOptions, type ClaudeRunResult, type RunMode } from "./claude";
import { agentDir, cleanedFile, ensureTmpDir, laneDir, laneRoot, removeNonKept, runLogDir } from "./paths";
import { listLiveProcesses, matchesSession, type LiveProcess } from "./processes";
import type { AgentRunner } from "./runner";
import { readState, writeState, type AgentStateFile } from "./state";
import { appendClosed, emptyConversation, readConversation, toConversationInfo, writeConversation, type ConversationRecord } from "./conversation";

const execFileAsync = promisify(execFile);

export interface InvokeInput {
  repo?: string;
  branch?: string;
  prompt: string;
  reason?: string;
  /** worker の持ち主 cap（mcp の header に入れる）。 */
  capId?: string;
  /** true なら activity の task を上書きしない（cap の report 起因の resume）。 */
  keepTask?: boolean;
  /** このエージェントの claude --model。省略時は前回記録した値、それも無ければ付けない。 */
  model?: string;
  /** cap が起動する worker の既定モデル（cap の記録に残す）。 */
  worker_model?: string;
  /** model も記録も無い時だけ使う既定（worker_start が cap の worker_model を渡す）。 */
  defaultModel?: string;
  /** 実際に使うモデル（manager が解決して observer に渡す）。 */
  resolvedModel?: string;
  /**
   * task_id。cap なら、その task だけを受け持つ指揮の会話（lane。cap の logs/tasks/<task_id>/ に state.json と logs/ を持ち、
   * cap の dir を cwd にする）で動かす。lane ごとに直列、別の lane・cap の本体（kick_cap）とは並行に動く。
   * worker なら、その worker を起動した task（持ち主の cap の lane）。実行の場所は変わらない（activeRuns・observer に載るだけ）。
   */
  taskId?: string;
}

export interface ReapSummary {
  killed: number;
  failed: number;
  errored: number;
  /** running から failed / error にした対象（activity の lost 登録用）。taskId = cap の task の lane。 */
  reaped: Array<{ kind: AgentKind; id: string; error: string; taskId?: string }>;
}

/** 実行の観測口（activity 用）。 */
export interface RunObserver {
  /** 子 spawn 時（retry ごと）。 */
  started(kind: AgentKind, id: string, input: InvokeInput, pid: number | undefined): void;
  /** stdout の空でない 1 行ごと。taskId = invoke の taskId（cap なら lane）。 */
  line(kind: AgentKind, id: string, line: string, taskId?: string): void;
  /** 最終 state を書いた後。lost = server 以外による signal 終了。 */
  finished(
    kind: AgentKind,
    id: string,
    outcome: {
      ok: boolean;
      lost: boolean;
      error?: string;
      /** 再試行（maxRetries）を使い切った後も時間切れで終わった。 */
      timedOut?: boolean;
      /** stop_cap / worker_stop / server 終了による中断（再開の対象にしない）。 */
      stopped?: boolean;
      /** この run を始めた時刻（ISO。再試行をまたいで同じ値）。 */
      startedAt?: string;
      /** invoke の taskId（cap なら lane、worker なら起動した task）。 */
      taskId?: string;
    },
  ): void;
}

export type RunExtras = Pick<ClaudeRunOptions, "mcpConfigFile" | "appendSystemPromptFile" | "extraAllowedTools">;

export interface AgentManagerDeps {
  config: Config;
  runner: AgentRunner;
  log: (msg: string) => void;
  /** プロセス一覧の取得（テストで差し替える）。取れなければ null。 */
  listProcesses?: () => Promise<LiveProcess[] | null>;
  /** pid を殺して消えるまで待つ。消えたら true（テストで差し替える）。 */
  terminate?: (pid: number) => Promise<boolean>;
  /** stop の SIGTERM から SIGKILL までの猶予（テストで短くする）。既定 3 秒。 */
  stopGraceMs?: number;
  /** 実行ごとの追加引数（mcp 設定・system prompt のファイルを書いて返す）。 */
  runExtras?: (kind: AgentKind, id: string, input: InvokeInput) => Promise<RunExtras>;
  observer?: RunObserver;
  /** invoke を受け付けた（activeRuns に載った）直後に同期で呼ぶ（task の lane の追跡用）。 */
  onRunAdded?: (run: ActiveRunRef) => void;
  /** invoke が終わった（activeRuns から外れた）直後に呼ぶ。outcome は成功・失敗の結果、投げた時は error。 */
  onRunSettled?: (run: ActiveRunRef, result: { outcome?: RunOutcome; error?: string }) => void;
}

/** onRunAdded / onRunSettled に渡す run。capId = cap の run なら cap_id、worker の run なら持ち主の cap。 */
export interface ActiveRunRef {
  kind: AgentKind;
  id: string;
  capId?: string;
  taskId?: string;
}

export interface AgentManager {
  invoke(kind: AgentKind, id: string, input: InvokeInput): Promise<RunOutcome>;
  /**
   * 実行中（または待ち）の指示を止める。走っている claude -p は process group ごと SIGTERM し、
   * 猶予内に終了しなければ SIGKILL する。待ちの指示は実行されずに失敗で返る。何も無ければ stopped=false。
   */
  stop(kind: AgentKind, id: string): Promise<{ stopped: boolean }>;
  /**
   * agent を閉じる（stop_cap）。実行中なら止め（実行が終わるまで待つ）、会話（state.json の session_id）を破棄して、
   * 次の指示を新しい会話で始める。idle / failed / error / 実行中のどれでも閉じられる。logs/ と worker の dir は残す。
   * 破棄した session は logs/closed.jsonl に追記する。cap なら、その cap の動いている（待ちを含む）worker も止め、
   * 閉じた印（メモリと logs/closed-mark.json）を付ける。印のある cap は worker の report / 終了で起こさない。
   */
  close(kind: AgentKind, id: string, reason?: string): Promise<CloseResult>;
  status(): Promise<{ caps: AgentStatus[]; workers: AgentStatus[] }>;
  reapOrphans(): Promise<ReapSummary>;
  /** invoke 中（待ち + 実行）の件数を kind 別に返す（退役の停止件数に使う）。 */
  activeCount(): { caps: number; workers: number };
  /**
   * invoke 中の指示の一覧（server 更新の「全部終わった」判定と、何を待っているかの表示に使う）。phase は
   * running = claude の子が生きている、preparing = 子がまだ居ない準備中・再試行の間・子が終わって結果を書いている途中
   * （子が exit したのに run が返らない間も含む。claude.ts が close を待つのは猶予の間だけ）、queued = 同じ agent の前の指示の後ろで待っている。
   */
  activeRuns(): ActiveRun[];
  /** stop_cap（close）で閉じた cap か。次に center から指示（task / kick_cap）が来るまで閉じたまま（server の再起動をまたぐ）。 */
  isClosed(id: string): boolean;
  /** 閉じた印（logs/closed-mark.json）を読み込む（server 起動時。worker の終了の回収より前に呼ぶ）。読み込んだ件数を返す。 */
  loadClosed(): Promise<number>;
  /** その agent に invoke 中（待ち + 実行）の指示があるか。cap は本体と全ての lane を見る。 */
  isActive(kind: AgentKind, id: string): boolean;
  /** cap の task（lane）の run（指揮の run と、その task の worker の run。待ちを含む）が 1 つでもあるか。 */
  laneBusy(capId: string, taskId: string): boolean;
  shutdown(): Promise<void>;
}

export interface ActiveRun {
  kind: AgentKind;
  id: string;
  /** worker の持ち主 cap（invoke の capId。分からなければ無い）。 */
  capId?: string;
  /** cap の run なら lane の task_id、worker の run なら起動した task の task_id（無ければ無い）。 */
  taskId?: string;
  /** この run を始めた時刻（ISO。待ちの間は invoke の時刻）。 */
  startedAt: string;
  phase: "queued" | "preparing" | "running";
  pid?: number;
}

/** 閉じた cap を worker の report / 終了で起こさない時の error 文言。 */
export const CLOSED_MSG = "cap は stop_cap で閉じられている（worker の report / 終了による再開はしない）";

export interface CloseResult {
  /** 実行中（または待ち）の指示を見つけて止めた。 */
  stopped: boolean;
  /** 会話（session_id）を破棄した。破棄するものが無かった（dir 無し・session 無し）なら false。 */
  session_cleared: boolean;
  /** 破棄した session_id（無ければ null）。 */
  previous_session_id: string | null;
  /** cap を閉じた時に止めた、その cap の worker の数（実行中と待ちの worker_id の数）。 */
  workers_stopped: number;
}

/** stop_cap で中断された指示の error 文言。 */
export const STOP_MSG = "stop_cap により停止";
/** stop の SIGTERM から SIGKILL までの既定の猶予。 */
const STOP_GRACE_MS = 3000;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** invoke 中の指示（activeRuns の元）。 */
interface RunEntry {
  kind: AgentKind;
  id: string;
  capId?: string;
  taskId?: string;
  /** invoke の時刻（ISO）。 */
  queuedAt: string;
  /** execute に入った時刻（ISO）。入る前（待ち）は undefined。 */
  startedAt?: string;
  /** 今の claude の子。spawn 前・run が返った後は undefined（準備中）。 */
  child?: ChildProcess;
}

/** 閉じた印のファイル（cap の logs/ の中）。 */
const closedMarkFile = (dir: string): string => join(runLogDir(dir), "closed-mark.json");

/** 子が生きているか。exit 済み（close 待ちを含む）や、pid が既に無いものは false。 */
export function childAlive(child: Pick<ChildProcess, "pid" | "exitCode" | "signalCode">): boolean {
  if (child.exitCode !== null || child.signalCode !== null) return false;
  if (child.pid === undefined) return false;
  try {
    process.kill(child.pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** SIGKILL を送り、signal 0 が通らなくなるまで 50ms × 100 回待つ。 */
async function killAndConfirm(pid: number): Promise<boolean> {
  try {
    process.kill(pid, "SIGKILL");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ESRCH") return true;
    throw e;
  }
  for (let i = 0; i < 100; i++) {
    try {
      process.kill(pid, 0);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ESRCH") return true;
    }
    await sleep(50);
  }
  return false;
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function git(args: string[], label: string): Promise<void> {
  try {
    await execFileAsync("git", args, {
      encoding: "utf8",
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      timeout: 300_000,
      killSignal: "SIGKILL",
    });
  } catch (e) {
    const err = e as NodeJS.ErrnoException & { stderr?: string; killed?: boolean };
    if (err.code === "ENOENT") throw new Error("git が見つからない");
    if (err.killed) throw new Error(`git ${label} タイムアウト`);
    throw new Error(`git ${label} 失敗: ${(err.stderr ?? "").trim() || err.message}`);
  }
}

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const isRetryable = (detail: string, timedOut: boolean): boolean =>
  timedOut || detail.startsWith("claude を起動できない");

export function createAgentManager(deps: AgentManagerDeps): AgentManager {
  const { config, runner, log } = deps;
  const listProcesses = deps.listProcesses ?? listLiveProcesses;
  const terminate = deps.terminate ?? killAndConfirm;
  const observer = deps.observer;
  const observe = (f: (o: RunObserver) => void): void => {
    if (!observer) return;
    try {
      f(observer);
    } catch (e) {
      log(`observer エラー: ${errMsg(e)}`);
    }
  };

  const chains = new Map<string, Promise<unknown>>();
  const waiting = new Map<string, number>();
  const live = new Set<{ child: ChildProcess; dir: string; key: string }>();
  /** invoke 中（待ち + 実行）の件数。stop の対象判定と、stop 要求の後始末に使う。 */
  const inflight = new Map<string, number>();
  /** stop 要求済みの key。inflight が 0 になったら消す。 */
  const stopRequests = new Set<string>();
  let shuttingDown = false;
  const SHUTDOWN_MSG = "server 終了により中断";
  /** invoke 中の指示（待ち + 実行）。 */
  const runs = new Set<RunEntry>();
  /** stop_cap で閉じた cap。center からの次の指示（keepTask でない invoke）で外す。 */
  const closedCaps = new Set<string>();
  /** cap ごとの、最後に始めた lane の task_id（status の集計用。無ければ起動後に 1 度だけ dir から探す）。 */
  const latestLanes = new Map<string, string>();
  const scannedLanes = new Set<string>();

  /** chain・inflight の key。cap の lane は `cap:<cap_id>/<task_id>`。worker は task に関わらず `worker:<id>`。 */
  const keyOf = (kind: AgentKind, id: string, taskId?: string): string =>
    kind === "cap" && taskId !== undefined ? `cap:${id}/${taskId}` : `${kind}:${id}`;
  /** その cap の、invoke 中の key（本体と lane）。 */
  const capKeys = (id: string): string[] => [...inflight.keys()].filter((k) => k === `cap:${id}` || k.startsWith(`cap:${id}/`));
  /** run の持ち主の cap（cap の run は自分、worker の run は capId）。 */
  const ownerCap = (r: Pick<RunEntry, "kind" | "id" | "capId">): string | undefined => (r.kind === "cap" ? r.id : r.capId);
  const refOf = (r: RunEntry): ActiveRunRef => {
    const cap = ownerCap(r);
    return { kind: r.kind, id: r.id, ...(cap !== undefined ? { capId: cap } : {}), ...(r.taskId !== undefined ? { taskId: r.taskId } : {}) };
  };
  const hook = (f: () => void): void => {
    try {
      f();
    } catch (e) {
      log(`run の hook エラー: ${errMsg(e)}`);
    }
  };

  /** cap の lane の task_id（dir のあるもの）。 */
  async function listLanes(capId: string): Promise<string[]> {
    try {
      const entries = await readdir(laneRoot(agentDir(config.workspace, "cap", capId)), { withFileTypes: true });
      return entries.filter((d) => d.isDirectory() && isValidAgentId(d.name)).map((d) => d.name).sort();
    } catch {
      return [];
    }
  }

  /** 最後に始めた lane（メモリに無ければ dir の state から 1 度だけ探す）。 */
  async function latestLane(capId: string): Promise<string | undefined> {
    const known = latestLanes.get(capId);
    if (known !== undefined || scannedLanes.has(capId)) return known;
    scannedLanes.add(capId);
    let best: { id: string; at: string } | undefined;
    for (const t of await listLanes(capId)) {
      const st = await readState(laneDir(config.workspace, capId, t)).catch(() => null);
      const at = st?.last_started_at ?? "";
      if (st && (best === undefined || at > best.at)) best = { id: t, at };
    }
    if (best !== undefined && !latestLanes.has(capId)) latestLanes.set(capId, best.id);
    return latestLanes.get(capId);
  }

  /** dir が既にあれば state を failed にする。失敗は握りつぶす。 */
  async function markFailed(dir: string, message: string): Promise<void> {
    try {
      if (!(await exists(dir))) return;
      const st = await readState(dir).catch(() => null);
      await writeState(dir, {
        session_id: st?.session_id ?? null,
        state: "failed",
        last_started_at: st?.last_started_at ?? null,
        last_finished_at: new Date().toISOString(),
        last_error: message,
        retries: st?.retries ?? 0,
      });
    } catch {
      // 記録に失敗しても元のエラーを優先する
    }
  }

  async function cloneRepo(target: string, repo: string, branch: string | undefined): Promise<void> {
    await git(["clone", ...(branch ? [`--branch=${branch}`] : []), "--", repo, target], "clone");
    const info = join(target, ".git", "info");
    await mkdir(info, { recursive: true });
    await appendFile(join(info, "exclude"), "state.json\nlogs/\ntmp/\n");
  }

  /** 掃除済み（logs/cleaned.json があり .git が無い）の worker の dir か。 */
  async function isCleaned(dir: string): Promise<boolean> {
    return (await exists(cleanedFile(dir))) && !(await exists(join(dir, ".git")));
  }

  /** clone の記録（掃除後の再開で、repo 指定が無くても clone し直せるように）。 */
  const repoRecordFile = (dir: string): string => join(runLogDir(dir), "repo.json");

  async function writeRepoRecord(dir: string, repo: string, branch: string | undefined): Promise<void> {
    await mkdir(runLogDir(dir), { recursive: true });
    // repo に認証情報が含まれうるので本人だけが読める
    await writeFile(repoRecordFile(dir), JSON.stringify({ repo, ...(branch ? { branch } : {}) }) + "\n", { mode: 0o600 });
  }

  async function readRepoRecord(dir: string): Promise<{ repo: string; branch?: string } | undefined> {
    try {
      const d = JSON.parse(await readFile(repoRecordFile(dir), "utf8")) as { repo?: unknown; branch?: unknown };
      if (typeof d.repo !== "string" || d.repo === "") return undefined;
      return { repo: d.repo, ...(typeof d.branch === "string" && d.branch !== "" ? { branch: d.branch } : {}) };
    } catch {
      return undefined;
    }
  }

  /** logs/ と state.json だけが残った dir に clone し直す（tmp に clone して中身を移す）。 */
  async function recloneInto(dir: string, repo: string, branch: string | undefined): Promise<void> {
    const tmp = `${dir}.clone-${randomUUID()}`;
    try {
      await cloneRepo(tmp, repo, branch);
      // 前回の掃除が途中で終わっていた場合の残りを先に消す
      await removeNonKept(dir);
      // .git は最後に移す（途中で失敗しても .git が無ければ次も clone し直しになる）
      const names = (await readdir(tmp)).filter((n) => n !== "logs" && n !== "state.json").sort((a, b) => (a === ".git" ? 1 : b === ".git" ? -1 : 0));
      for (const name of names) await rename(join(tmp, name), join(dir, name));
      await unlink(cleanedFile(dir)).catch(() => {});
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  }

  /** 掃除済みで clone 元の記録が無い（repo 引数なしで作った）worker の再開の prompt に足す 1 行。 */
  const EMPTIED_NOTE = "（server 注記: この dir は掃除されて空。必要なら自分で clone し直すこと）";

  /** 戻り値 true = 掃除済みの dir を、clone し直さず空のまま使う。 */
  async function prepareDir(kind: AgentKind, dir: string, input: InvokeInput): Promise<boolean> {
    let { repo, branch } = input;
    let emptied = false;
    // 掃除済みの worker は、repo の指定が無くても前回の clone 元で clone し直す。
    // 記録（repo 引数付きで作った worker のみ書かれる）が無ければ clone 元は無い（worker が自分で clone する運用）ので、空の dir で起動する
    if (!repo && kind === "worker" && (await isCleaned(dir))) {
      const rec = await readRepoRecord(dir);
      if (rec) ({ repo, branch } = rec);
      else emptied = true;
    }
    if (!repo) {
      await mkdir(dir, { recursive: true });
      if (emptied) {
        // 空の dir で起動するのはこの 1 回だけ（以後は worker が自分で clone して作業する）。
        // 掃除が途中で止まった残骸を消し、印を外す（印が残ると再開のたびに「掃除済み」と判定される）
        await removeNonKept(dir);
        await unlink(cleanedFile(dir)).catch(() => {});
      }
      return emptied;
    }
    if (repo.startsWith("-") || (branch !== undefined && branch.startsWith("-"))) {
      throw new Error("repo / branch は - で始められない");
    }
    if (await exists(join(dir, ".git"))) {
      await git(["-C", dir, "fetch"], "fetch");
    } else if (!(await exists(dir))) {
      await mkdir(join(dir, ".."), { recursive: true });
      await cloneRepo(dir, repo, branch);
      await writeRepoRecord(dir, repo, branch).catch((e: unknown) => log(`repo 記録失敗: kind=${kind} dir=${dir} ${errMsg(e)}`));
    } else if (kind === "worker" && (await isCleaned(dir))) {
      log(`掃除済みの worker を clone し直す: dir=${dir}`);
      await recloneInto(dir, repo, branch);
      await writeRepoRecord(dir, repo, branch).catch((e: unknown) => log(`repo 記録失敗: kind=${kind} dir=${dir} ${errMsg(e)}`));
    } else {
      throw new Error(`${kind} の path は git repo でない: ${dir}`);
    }
    return false;
  }

  async function execute(kind: AgentKind, id: string, input: InvokeInput, run: RunEntry): Promise<RunOutcome> {
    run.startedAt = new Date().toISOString();
    try {
      return await executeInner(kind, id, input, run);
    } catch (e) {
      // 投げた場合（prepareDir 失敗など）も activity を終端にする
      observe((o) => o.finished(kind, id, { ok: false, lost: false, error: errMsg(e), ...(input.taskId !== undefined ? { taskId: input.taskId } : {}) }));
      throw e;
    }
  }

  async function executeInner(kind: AgentKind, id: string, input: InvokeInput, run: RunEntry): Promise<RunOutcome> {
    if (shuttingDown) throw new Error("server 終了中");
    // cap の lane: 記録（state.json・logs/）は lane の dir、claude の cwd は cap の dir
    const lane = kind === "cap" ? input.taskId : undefined;
    const key = keyOf(kind, id, lane);
    const cwd = agentDir(config.workspace, kind, id);
    const dir = lane !== undefined ? laneDir(config.workspace, id, lane) : cwd;
    const taskTag = input.taskId !== undefined ? { taskId: input.taskId } : {};
    if (stopRequests.has(key)) {
      observe((o) => o.finished(kind, id, { ok: false, lost: false, error: STOP_MSG, stopped: true, ...taskTag }));
      return { session_id: (await readState(dir).catch(() => null))?.session_id ?? "", ok: false, result_text: "", error: STOP_MSG };
    }
    try {
      if (lane !== undefined) await mkdir(dir, { recursive: true });
      else if (await prepareDir(kind, dir, input)) input = { ...input, prompt: `${input.prompt}\n\n${EMPTIED_NOTE}` };
    } catch (e) {
      await markFailed(dir, errMsg(e));
      throw e;
    }
    const st = await readState(dir);
    if (st.state === "running") throw new Error(`${lane !== undefined ? `${id} の task ${lane}` : id} は実行中`);
    if (lane !== undefined) latestLanes.set(id, lane);
    // 指定があれば記録し、無ければ前回の記録を使う（resume / report 起因の再開でも同じモデルを使い続ける）。
    // lane は cap の記録（kick_cap の model・cap の既定の worker_model）を下敷きにする
    const rec0 = lane !== undefined ? { ...(await readModelRecord(cwd)), ...(await readModelRecord(dir)) } : await readModelRecord(dir);
    const patch = {
      ...(input.model !== undefined ? { model: input.model } : rec0.model === undefined && input.defaultModel !== undefined ? { model: input.defaultModel } : {}),
      ...(input.worker_model !== undefined ? { worker_model: input.worker_model } : {}),
    };
    const rec = { ...rec0, ...patch };
    if (Object.keys(patch).length > 0) {
      await writeModelRecord(dir, patch).catch((e: unknown) => log(`model 記録失敗: kind=${kind} id=${id} ${errMsg(e)}`));
      // task の worker_model は cap の既定としても残す（後の task が省いた時に使う。従来どおり）
      if (lane !== undefined && input.worker_model !== undefined) {
        await writeModelRecord(cwd, { worker_model: input.worker_model }).catch((e: unknown) => log(`model 記録失敗: kind=${kind} id=${id} ${errMsg(e)}`));
      }
    }
    const model = rec.model;
    input = { ...input, ...(model !== undefined ? { resolvedModel: model } : {}) };
    if (st.state === "error") {
      throw new Error(`${id} は state=error のため起動しない（state.json を確認）`);
    }

    let mode: RunMode = st.session_id ? "resume" : "new";
    let sessionId = st.session_id ?? randomUUID();
    const startedAt = new Date().toISOString();
    // 会話の記録（開始時刻・run 数・使用量）。補助情報なので書けなくても実行は止めない
    let conv: ConversationRecord = mode === "new" ? emptyConversation() : await readConversation(dir);
    if (mode === "new" || conv.started_at === null) conv = { ...conv, started_at: startedAt };
    conv = { ...conv, tasks: conv.tasks + 1 };
    const saveConv = (): Promise<void> => writeConversation(dir, conv).catch((e: unknown) => log(`conversation 記録失敗: kind=${kind} id=${id} ${errMsg(e)}`));
    await saveConv();
    const base = (): AgentStateFile => ({
      session_id: sessionId,
      state: "running",
      last_started_at: startedAt,
      last_finished_at: st.last_finished_at,
      retries: 0,
    });
    try {
      await writeState(dir, base());
      log(`claude 起動: kind=${kind} id=${id}${lane !== undefined ? ` task=${lane}` : ""} mode=${mode} session=${sessionId} cwd=${cwd}`);

      let retriesUsed = 0;
      let switched = false;
      let lastChild: ChildProcess | undefined;
      let r: ClaudeRunResult;
      for (;;) {
        if (shuttingDown) throw new Error(SHUTDOWN_MSG);
        if (stopRequests.has(key)) {
          r = { ok: false, sessionMissing: false, timedOut: false, detail: STOP_MSG, durationMs: 0 };
          break;
        }
        const extras = deps.runExtras ? await deps.runExtras(kind, id, input) : {};
        // clone などの準備の後、起動のたび（resume でも）に tmp/ を用意する。在れば何もしない（lane は cap の tmp/ を使う）
        const tmp = await ensureTmpDir(cwd);
        r = await runner.run({
          ...extras,
          claude: config.session.claude,
          sessionId,
          mode,
          prompt: input.prompt,
          cwd,
          permissionMode: config.session.permissionMode,
          allowedTools: config.session.allowedTools,
          disallowedTools: config.session.disallowedTools,
          capBashSandbox: config.session.capBashSandbox,
          extraArgs: config.session.extraArgs,
          ...(model !== undefined ? { model } : {}),
          timeoutMs: config.session.timeoutMs,
          // TMPDIR は config.session.env でも上書きさせない（自分の path の tmp/ だけ）
          env: { ...process.env, ...config.session.env, TMPDIR: tmp },
          logFile: join(runLogDir(dir), `${sessionId}.jsonl`),
          onLine: (line) => observe((o) => o.line(kind, id, line, input.taskId)),
          onSpawn: (child) => {
            lastChild = child;
            run.child = child;
            observe((o) => o.started(kind, id, input, child.pid));
            const entry = { child, dir, key };
            live.add(entry);
            if (shuttingDown) killGroup(child, "SIGKILL");
            child.once("close", () => live.delete(entry));
          },
        });
        // run が返った（子は終わった）。次の再試行の spawn までは準備中として数える
        run.child = undefined;
        if (r.ok || shuttingDown) break;
        if (stopRequests.has(key)) {
          r = { ...r, detail: STOP_MSG };
          break;
        }
        if (r.sessionMissing && mode === "resume" && !switched) {
          switched = true;
          log(`session が無いので新規に切り替え: kind=${kind} id=${id} old=${sessionId}`);
          sessionId = randomUUID();
          mode = "new";
          await writeState(dir, base());
          // 別の会話になる
          conv = { ...emptyConversation(), started_at: new Date().toISOString(), tasks: 1 };
          await saveConv();
          continue;
        }
        if (isRetryable(r.detail, r.timedOut) && retriesUsed < config.session.maxRetries) {
          retriesUsed++;
          log(`再試行 ${retriesUsed}/${config.session.maxRetries}: ${r.detail}`);
          if (mode === "new") {
            // 失敗した new 実行は session が作られたか不明。同じ id の再利用は避ける
            sessionId = randomUUID();
            await writeState(dir, base());
          }
          continue;
        }
        break;
      }

      const finished = new Date().toISOString();
      // 使用量は読めた時だけ更新（読めなければ直近の値を残す）。error 文は直近の run のものだけ持つ
      if (r.usage && (r.usage.contextTokens !== null || r.usage.contextWindow !== null)) {
        conv = {
          ...conv,
          context_tokens: r.usage.contextTokens ?? conv.context_tokens,
          context_window: r.usage.contextWindow ?? conv.context_window,
          usage_at: finished,
        };
      }
      delete conv.last_error_text;
      if (!r.ok && r.errorText !== undefined) conv.last_error_text = r.errorText;
      await saveConv();
      if (r.ok) {
        await writeState(dir, {
          session_id: sessionId,
          state: "idle",
          last_started_at: startedAt,
          last_finished_at: finished,
          retries: retriesUsed,
        });
        log(`claude 終了: kind=${kind} id=${id}${lane !== undefined ? ` task=${lane}` : ""} session=${sessionId} ok=true ms=${r.durationMs} retries=${retriesUsed}`);
        observe((o) => o.finished(kind, id, { ok: true, lost: false, startedAt, ...taskTag }));
        return { session_id: sessionId, ok: true, result_text: r.resultText };
      }
      const detail = shuttingDown ? SHUTDOWN_MSG : r.detail;
      await writeState(dir, {
        session_id: sessionId,
        state: "failed",
        last_started_at: startedAt,
        last_finished_at: finished,
        last_error: detail,
        retries: retriesUsed,
      });
      log(`claude 終了: kind=${kind} id=${id}${lane !== undefined ? ` task=${lane}` : ""} session=${sessionId} ok=false ms=${r.durationMs} retries=${retriesUsed} error=${detail}`);
      // server 自身の kill（timeout・stop・shutdown）でない signal 終了は lost
      const sig = r.ok ? null : (r.signal ?? null);
      const lost = sig !== null && !r.timedOut && !shuttingDown && !stopRequests.has(key);
      const lostError = `signal ${sig} で終了（server からの停止ではない）`;
      if (lost && lastChild) {
        // 外から claude 本体だけ kill されると、同じ group に子（Bash の実行物）が残る
        try {
          killGroup(lastChild, "SIGKILL");
        } catch {
          // 既に居ない
        }
      }
      const stopped = shuttingDown || stopRequests.has(key);
      observe((o) => o.finished(kind, id, { ok: false, lost, error: lost ? lostError : detail, timedOut: r.timedOut, stopped, startedAt, ...taskTag }));
      return { session_id: sessionId, ok: false, result_text: "", error: detail };
    } catch (e) {
      await markFailed(dir, errMsg(e));
      throw e;
    }
  }

  function settled(key: string): void {
    const n = (inflight.get(key) ?? 1) - 1;
    if (n > 0) {
      inflight.set(key, n);
      return;
    }
    inflight.delete(key);
    stopRequests.delete(key);
  }

  async function stop(kind: AgentKind, id: string): Promise<{ stopped: boolean }> {
    if (!isValidAgentId(id)) throw new Error(kind === "cap" ? `cap_id が不正: ${id}` : `worker_id が不正: ${id}`);
    // cap は本体と全ての task の lane を止める
    const keys = kind === "cap" ? capKeys(id) : inflight.has(`worker:${id}`) ? [`worker:${id}`] : [];
    if (keys.length === 0) return { stopped: false };
    for (const k of keys) stopRequests.add(k);
    const targets = [...live].filter((t) => keys.includes(t.key));
    const key = keys.join(" ");
    log(`stop 要求: ${key} 実行中の子=${targets.length} 待ち=${keys.reduce((n, k) => n + (waiting.get(k) ?? 0), 0)}`);
    const closed = (c: ChildProcess): Promise<boolean> =>
      c.exitCode !== null || c.signalCode !== null
        ? Promise.resolve(true)
        : new Promise<boolean>((resolve) => {
            c.once("close", () => resolve(true));
            setTimeout(() => resolve(false), deps.stopGraceMs ?? STOP_GRACE_MS);
          });
    for (const t of targets) killGroup(t.child, "SIGTERM");
    const results = await Promise.all(targets.map((t) => closed(t.child)));
    targets.forEach((t, i) => {
      if (results[i]) return;
      log(`stop: SIGKILL ${t.key} pid=${t.child.pid ?? "?"}`);
      killGroup(t.child, "SIGKILL");
    });
    return { stopped: true };
  }

  async function clearSession(dir: string, reason: string): Promise<{ cleared: boolean; previous: string | null }> {
    if (!(await exists(dir))) return { cleared: false, previous: null };
    // state.json が壊れていても閉じられるようにする（読めなければ session 無しとして作り直す）
    const st = await readState(dir).catch(() => null);
    const previous = st?.session_id ?? null;
    if (previous !== null) {
      await appendClosed(dir, { closed_at: new Date().toISOString(), session_id: previous, reason, conversation: await readConversation(dir) });
    }
    await writeState(dir, {
      session_id: null,
      state: "idle",
      last_started_at: st?.last_started_at ?? null,
      last_finished_at: st?.last_finished_at ?? null,
      retries: 0,
    });
    await writeConversation(dir, emptyConversation());
    return { cleared: previous !== null, previous };
  }

  async function close(kind: AgentKind, id: string, reason = "stop_cap"): Promise<CloseResult> {
    // 閉じた cap は、center が次に指示するまで worker の report / 終了で起こさない（stop の前に印を付け、止めている間の再開も断る）
    if (kind === "cap" && isValidAgentId(id)) closedCaps.add(id);
    // その cap の worker（実行中・待ち）も止める。閉じた cap は起こさないので、結果を待つ者が居ない
    const workerIds = kind === "cap" ? [...new Set([...runs].filter((r) => r.kind === "worker" && r.capId === id).map((r) => r.id))] : [];
    if (workerIds.length > 0) log(`close: cap:${id} の worker を止める: ${workerIds.join(" ")}`);
    const [{ stopped }, workerStops] = await Promise.all([stop(kind, id), Promise.all(workerIds.map((w) => stop("worker", w).catch(() => ({ stopped: false }))))]);
    const workersStopped = workerStops.filter((r) => r.stopped).length;
    const key = `${kind}:${id}`;
    // task の lane の会話も破棄する（会話のある lane だけ）。各 lane の chain に載せる
    const lanes = kind === "cap" ? await listLanes(id) : [];
    const laneClears = Promise.all(
      lanes.map((t) =>
        onChain(keyOf("cap", id, t), async () => {
          const dir = laneDir(config.workspace, id, t);
          const st = await readState(dir).catch(() => null);
          if (st !== null && st.session_id === null) return { cleared: false, previous: null };
          return clearSession(dir, reason);
        }),
      ),
    );
    // 止めた実行が state を書き終えるまで待ち、同じ key の他の指示と並べて（chain に載せて）破棄する。
    // chain の間は stopRequests が残るので、閉じている間に来た指示は実行されず STOP で返る
    const r = await onChain(key, async () => {
      const main = await clearSession(agentDir(config.workspace, kind, id), reason);
      const laneResults = await laneClears;
      // 印はファイルにも残す（server の再起動後も、worker の終了の回収・report で起こさない）。chain の上で書くので、後に来た kick_cap が消す
      if (kind === "cap" && closedCaps.has(id)) await writeClosedMark(id, reason);
      const lanePrev = laneResults.find((x) => x.cleared)?.previous ?? null;
      return { cleared: main.cleared || laneResults.some((x) => x.cleared), previous: main.previous ?? lanePrev, lanes: laneResults.filter((x) => x.cleared).length };
    });
    log(`close: ${key} stopped=${stopped} workers_stopped=${workersStopped} session_cleared=${r.cleared} previous=${r.previous ?? "-"} lanes_cleared=${r.lanes}`);
    return { stopped, session_cleared: r.cleared, previous_session_id: r.previous, workers_stopped: workersStopped };
  }

  /** key の chain に fn を載せる（invoke 中として数え、前の指示の後に実行する）。 */
  function onChain<T>(key: string, fn: () => Promise<T>): Promise<T> {
    inflight.set(key, (inflight.get(key) ?? 0) + 1);
    const prev = chains.get(key) ?? Promise.resolve();
    const run = prev.then(fn);
    void run.then(
      () => settled(key),
      () => settled(key),
    );
    const tail = run.catch(() => undefined);
    chains.set(key, tail);
    void tail.then(() => {
      if (chains.get(key) === tail) chains.delete(key);
    });
    return run;
  }

  async function writeClosedMark(id: string, reason: string): Promise<void> {
    const dir = agentDir(config.workspace, "cap", id);
    if (!(await exists(dir))) return;
    try {
      await mkdir(runLogDir(dir), { recursive: true });
      await writeFile(closedMarkFile(dir), JSON.stringify({ closed_at: new Date().toISOString(), reason }) + "\n");
    } catch (e) {
      log(`閉じた印を書けない: cap_id=${id} ${errMsg(e)}`);
    }
  }

  async function loadClosed(): Promise<number> {
    let n = 0;
    for (const id of await listIds("cap")) {
      if (await exists(closedMarkFile(agentDir(config.workspace, "cap", id)))) {
        closedCaps.add(id);
        n++;
      }
    }
    return n;
  }

  function invoke(kind: AgentKind, id: string, input: InvokeInput): Promise<RunOutcome> {
    if (!isValidAgentId(id)) {
      return Promise.reject(new Error(kind === "cap" ? `cap_id が不正: ${id}` : `worker_id が不正: ${id}`));
    }
    if (input.taskId !== undefined && !isValidAgentId(input.taskId)) return Promise.reject(new Error(`task_id が不正: ${input.taskId}`));
    try {
      if (input.model !== undefined) assertModel(input.model, "model");
      if (input.worker_model !== undefined) assertModel(input.worker_model, "worker_model");
      if (input.defaultModel !== undefined) assertModel(input.defaultModel, "model");
    } catch (e) {
      return Promise.reject(e);
    }
    let reopen = false;
    if (kind === "cap") {
      // worker の report / 終了による再開（keepTask）は閉じた cap を起こさない。center からの指示は閉じた印を外して新しい会話で始める
      if (input.keepTask === true && closedCaps.has(id)) return Promise.reject(new Error(CLOSED_MSG));
      if (input.keepTask !== true) {
        closedCaps.delete(id);
        reopen = true;
      }
    }
    const key = keyOf(kind, id, kind === "cap" ? input.taskId : undefined);
    const entry: RunEntry = {
      kind,
      id,
      ...(input.capId !== undefined ? { capId: input.capId } : {}),
      ...(input.taskId !== undefined ? { taskId: input.taskId } : {}),
      queuedAt: new Date().toISOString(),
    };
    runs.add(entry);
    inflight.set(key, (inflight.get(key) ?? 0) + 1);
    waiting.set(key, (waiting.get(key) ?? 0) + 1);
    if (deps.onRunAdded) hook(() => deps.onRunAdded!(refOf(entry)));
    const prev = chains.get(key) ?? Promise.resolve();
    const run = prev.then(async () => {
      waiting.set(key, (waiting.get(key) ?? 1) - 1);
      // 閉じた印のファイルは chain の上で消す（前の close が書いた後）。消せなくても実行は止めない
      if (reopen) await rm(closedMarkFile(agentDir(config.workspace, "cap", id)), { force: true }).catch(() => {});
      return execute(kind, id, input, entry);
    });
    const done = (result: { outcome?: RunOutcome; error?: string }): void => {
      runs.delete(entry);
      settled(key);
      if (deps.onRunSettled) hook(() => deps.onRunSettled!(refOf(entry), result));
    };
    void run.then(
      (outcome) => done({ outcome }),
      (e: unknown) => done({ error: errMsg(e) }),
    );
    const tail = run.catch(() => undefined);
    chains.set(key, tail);
    void tail.then(() => {
      if (chains.get(key) === tail) chains.delete(key);
    });
    return run;
  }

  async function listIds(kind: AgentKind): Promise<string[]> {
    const root = join(config.workspace, kind === "cap" ? "caps" : "workers");
    let entries;
    try {
      entries = await readdir(root, { withFileTypes: true });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw e;
    }
    return entries
      .filter((d) => d.isDirectory() && isValidAgentId(d.name))
      .map((d) => d.name)
      .sort();
  }

  /**
   * cap の status: 本体（kick_cap の会話）と task の lane（invoke 中のものと、最後に始めたもの）をまとめる。
   * state は 1 つでも running なら running。代表（session_id・model・conversation・last_error・retries の出所）は、
   * running の中で最後に始めたもの、無ければ最後に終わったもの（本体が error なら本体）。queued は全ての待ちの合計。
   */
  async function capStatusOf(id: string): Promise<WithModel<AgentStatus>> {
    const cwd = agentDir(config.workspace, "cap", id);
    const keys = new Set([`cap:${id}`, ...capKeys(id)]);
    const queued = [...keys].reduce((n, k) => n + (waiting.get(k) ?? 0), 0);
    const laneIds = new Set(capKeys(id).filter((k) => k.startsWith(`cap:${id}/`)).map((k) => k.slice(`cap:${id}/`.length)));
    const latest = await latestLane(id);
    if (latest !== undefined) laneIds.add(latest);
    try {
      const main = { dir: cwd, s: await readState(cwd) };
      const lanes: Array<{ dir: string; s: AgentStateFile }> = [];
      for (const t of [...laneIds].sort()) {
        const dir = laneDir(config.workspace, id, t);
        const s = await readState(dir).catch(() => null);
        if (s !== null && (s.last_started_at !== null || s.state !== "idle")) lanes.push({ dir, s });
      }
      const all = [main, ...lanes];
      const running = all.filter((x) => x.s.state === "running");
      const at = (x: { s: AgentStateFile }, k: "last_started_at" | "last_finished_at"): string => x.s[k] ?? "";
      const pick = (xs: typeof all, by: (x: (typeof all)[number]) => string): (typeof all)[number] => xs.reduce((a, b) => (by(b) > by(a) ? b : a));
      const rep =
        running.length > 0
          ? pick(running, (x) => at(x, "last_started_at"))
          : main.s.state === "error"
            ? main
            : pick(all, (x) => at(x, "last_finished_at") || at(x, "last_started_at"));
      const maxOf = (k: "last_started_at" | "last_finished_at"): string | null => all.map((x) => x.s[k]).reduce<string | null>((a, b) => (b !== null && (a === null || b > a) ? b : a), null);
      const repModel = (await readModelRecord(rep.dir)).model ?? (rep.dir !== cwd ? (await readModelRecord(cwd)).model : undefined);
      const out: WithModel<AgentStatus> = {
        kind: "cap",
        id,
        path: cwd,
        session_id: rep.s.session_id,
        state: running.length > 0 ? "running" : rep.s.state,
        last_started_at: maxOf("last_started_at"),
        last_finished_at: maxOf("last_finished_at"),
        retries: rep.s.retries,
        queued,
        model: repModel ?? null,
        conversation: toConversationInfo(await readConversation(rep.dir)),
      };
      if (rep.s.last_error !== undefined) out.last_error = rep.s.last_error;
      return out;
    } catch (e) {
      return {
        kind: "cap",
        id,
        path: cwd,
        session_id: null,
        state: "error",
        last_started_at: null,
        last_finished_at: null,
        last_error: errMsg(e),
        retries: 0,
        queued,
      };
    }
  }

  async function statusOf(kind: AgentKind, id: string): Promise<WithModel<AgentStatus>> {
    if (kind === "cap") return capStatusOf(id);
    const dir = agentDir(config.workspace, kind, id);
    const queued = waiting.get(`${kind}:${id}`) ?? 0;
    try {
      const s = await readState(dir);
      const out: WithModel<AgentStatus> = {
        kind,
        id,
        path: dir,
        session_id: s.session_id,
        state: s.state,
        last_started_at: s.last_started_at,
        last_finished_at: s.last_finished_at,
        retries: s.retries,
        queued,
        model: (await readModelRecord(dir)).model ?? null,
        conversation: toConversationInfo(await readConversation(dir)),
      };
      if (s.last_error !== undefined) out.last_error = s.last_error;
      return out;
    } catch (e) {
      return {
        kind,
        id,
        path: dir,
        session_id: null,
        state: "error",
        last_started_at: null,
        last_finished_at: null,
        last_error: errMsg(e),
        retries: 0,
        queued,
      };
    }
  }

  async function status(): Promise<{ caps: AgentStatus[]; workers: AgentStatus[] }> {
    const [capIds, workerIds] = await Promise.all([listIds("cap"), listIds("worker")]);
    const [caps, workers] = await Promise.all([
      Promise.all(capIds.map((id) => statusOf("cap", id))),
      Promise.all(workerIds.map((id) => statusOf("worker", id))),
    ]);
    return { caps, workers };
  }

  async function reapOrphans(): Promise<ReapSummary> {
    const sum: ReapSummary = { killed: 0, failed: 0, errored: 0, reaped: [] };
    let procs: LiveProcess[] | null | undefined;
    // 対象: cap の本体・cap の task の lane・worker
    const targets: Array<{ kind: AgentKind; id: string; dir: string; taskId?: string }> = [];
    for (const kind of ["cap", "worker"] as const) {
      for (const id of await listIds(kind)) {
        targets.push({ kind, id, dir: agentDir(config.workspace, kind, id) });
        if (kind === "cap") for (const t of await listLanes(id)) targets.push({ kind, id, dir: laneDir(config.workspace, id, t), taskId: t });
      }
    }
    for (const { kind, id, dir, taskId } of targets) {
      const what = `kind=${kind} id=${id}${taskId !== undefined ? ` task=${taskId}` : ""}`;
      const tag = taskId !== undefined ? { taskId } : {};
      try {
        let st: AgentStateFile;
        try {
          st = await readState(dir);
        } catch (e) {
          log(`孤児回収: state を読めない ${what}: ${errMsg(e)}`);
          sum.errored++;
          continue;
        }
        if (st.state !== "running") continue;
        const now = new Date().toISOString();
        const next = (state: "failed" | "error", err: string): AgentStateFile => ({
          ...st,
          state,
          last_finished_at: now,
          last_error: err,
        });
        if (procs === undefined) procs = await listProcesses();
        if (procs === null) {
          await writeState(dir, next("error", "プロセス一覧を取れず孤児を判定できない"));
          log(`孤児回収: ps 不可 ${what}`);
          sum.errored++;
          continue;
        }
        const hit = st.session_id
          ? procs.filter((p) => p.pid !== process.pid && matchesSession(p.argv, st.session_id as string))
          : [];
        if (hit.length === 0) {
          await writeState(dir, next("failed", "前回の実行が終了しないまま server が落ちた"));
          sum.reaped.push({ kind, id, error: "前回の実行が終了しないまま server が落ちた", ...tag });
          log(`孤児回収: プロセス無し ${what} → failed`);
          sum.failed++;
          continue;
        }
        let allDead = true;
        for (const p of hit) {
          const dead = await terminate(p.pid).catch(() => false);
          log(`孤児回収: SIGKILL pid=${p.pid} ${what} dead=${dead}`);
          if (!dead) allDead = false;
        }
        if (allDead) {
          await writeState(dir, next("failed", "起動時に孤児プロセスを回収"));
          sum.reaped.push({ kind, id, error: "起動時に孤児プロセスを回収", ...tag });
          sum.killed++;
        } else {
          await writeState(dir, next("error", "孤児プロセスを止められない"));
          sum.errored++;
        }
      } catch (e) {
        log(`孤児回収: 失敗 ${what}: ${errMsg(e)}`);
        sum.errored++;
      }
    }
    return sum;
  }

  async function shutdown(): Promise<void> {
    shuttingDown = true;
    const targets = [...live];
    for (const t of targets) killGroup(t.child, "SIGKILL");
    for (const t of targets) await markFailed(t.dir, SHUTDOWN_MSG);
    await Promise.allSettled([...chains.values()]);
  }

  function activeCount(): { caps: number; workers: number } {
    let caps = 0;
    let workers = 0;
    for (const [key, n] of inflight) {
      if (key.startsWith("cap:")) caps += n;
      else workers += n;
    }
    return { caps, workers };
  }

  function isActive(kind: AgentKind, id: string): boolean {
    return kind === "cap" ? capKeys(id).length > 0 : inflight.has(`${kind}:${id}`);
  }

  function laneBusy(capId: string, taskId: string): boolean {
    for (const r of runs) if (r.taskId === taskId && ownerCap(r) === capId) return true;
    return false;
  }

  function activeRuns(): ActiveRun[] {
    const out: ActiveRun[] = [];
    for (const r of runs) {
      const base = {
        kind: r.kind,
        id: r.id,
        ...(r.capId !== undefined ? { capId: r.capId } : {}),
        ...(r.taskId !== undefined ? { taskId: r.taskId } : {}),
        startedAt: r.startedAt ?? r.queuedAt,
      };
      if (r.startedAt === undefined) out.push({ ...base, phase: "queued" });
      else if (r.child !== undefined && childAlive(r.child)) out.push({ ...base, phase: "running", ...(r.child.pid !== undefined ? { pid: r.child.pid } : {}) });
      // spawn 前・再試行の間・子が exit した後（結果を書き終えて返るまで）は準備中として数える
      else out.push({ ...base, phase: "preparing" });
    }
    return out;
  }

  return { invoke, stop, close, status, reapOrphans, activeCount, activeRuns, isClosed: (id) => closedCaps.has(id), loadClosed, isActive, laneBusy, shutdown };
}
