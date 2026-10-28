import { execFile, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  isValidAgentId,
  type AgentKind,
  type AgentStatus,
  type RunOutcome,
} from "@agent-hand/bantou-protocol";
import type { Config } from "./config";
import type { RunMode } from "./claude";
import { agentDir, runLogDir } from "./paths";
import { listLiveProcesses, matchesSession, type LiveProcess } from "./processes";
import type { AgentRunner } from "./runner";
import { readState, writeState, type AgentStateFile } from "./state";

const execFileAsync = promisify(execFile);

export interface InvokeInput {
  repo?: string;
  branch?: string;
  prompt: string;
  reason?: string;
}

export interface ReapSummary {
  killed: number;
  failed: number;
  errored: number;
}

export interface AgentManagerDeps {
  config: Config;
  runner: AgentRunner;
  log: (msg: string) => void;
  /** プロセス一覧の取得（テストで差し替える）。取れなければ null。 */
  listProcesses?: () => Promise<LiveProcess[] | null>;
  /** pid を殺して消えるまで待つ。消えたら true（テストで差し替える）。 */
  terminate?: (pid: number) => Promise<boolean>;
}

export interface AgentManager {
  invoke(kind: AgentKind, id: string, input: InvokeInput): Promise<RunOutcome>;
  status(): Promise<{ caps: AgentStatus[]; workers: AgentStatus[] }>;
  reapOrphans(): Promise<ReapSummary>;
  shutdown(): Promise<void>;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

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

  const chains = new Map<string, Promise<unknown>>();
  const waiting = new Map<string, number>();
  const live = new Set<{ child: ChildProcess; dir: string }>();
  let shuttingDown = false;
  const SHUTDOWN_MSG = "server 終了により中断";

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

  async function prepareDir(kind: AgentKind, dir: string, input: InvokeInput): Promise<void> {
    const { repo, branch } = input;
    if (!repo) {
      await mkdir(dir, { recursive: true });
      return;
    }
    if (repo.startsWith("-") || (branch !== undefined && branch.startsWith("-"))) {
      throw new Error("repo / branch は - で始められない");
    }
    if (await exists(join(dir, ".git"))) {
      await git(["-C", dir, "fetch"], "fetch");
    } else if (!(await exists(dir))) {
      await mkdir(join(dir, ".."), { recursive: true });
      await git(["clone", ...(branch ? [`--branch=${branch}`] : []), "--", repo, dir], "clone");
      const info = join(dir, ".git", "info");
      await mkdir(info, { recursive: true });
      await appendFile(join(info, "exclude"), "state.json\nlogs/\n");
    } else {
      throw new Error(`${kind} の path は git repo でない: ${dir}`);
    }
  }

  async function execute(kind: AgentKind, id: string, input: InvokeInput): Promise<RunOutcome> {
    if (shuttingDown) throw new Error("server 終了中");
    const dir = agentDir(config.workspace, kind, id);
    try {
      await prepareDir(kind, dir, input);
    } catch (e) {
      await markFailed(dir, errMsg(e));
      throw e;
    }
    const st = await readState(dir);
    if (st.state === "running") throw new Error(`${id} は実行中`);
    if (st.state === "error") {
      throw new Error(`${id} は state=error のため起動しない（state.json を確認）`);
    }

    let mode: RunMode = st.session_id ? "resume" : "new";
    let sessionId = st.session_id ?? randomUUID();
    const startedAt = new Date().toISOString();
    const base = (): AgentStateFile => ({
      session_id: sessionId,
      state: "running",
      last_started_at: startedAt,
      last_finished_at: st.last_finished_at,
      retries: 0,
    });
    try {
      await writeState(dir, base());
      log(`claude 起動: kind=${kind} id=${id} mode=${mode} session=${sessionId} cwd=${dir}`);

      let retriesUsed = 0;
      let switched = false;
      let r;
      for (;;) {
        if (shuttingDown) throw new Error(SHUTDOWN_MSG);
        r = await runner.run({
          claude: config.session.claude,
          sessionId,
          mode,
          prompt: input.prompt,
          cwd: dir,
          permissionMode: config.session.permissionMode,
          allowedTools: config.session.allowedTools,
          disallowedTools: config.session.disallowedTools,
          capBashSandbox: config.session.capBashSandbox,
          extraArgs: config.session.extraArgs,
          timeoutMs: config.session.timeoutMs,
          env: { ...process.env, ...config.session.env },
          logFile: join(runLogDir(dir), `${sessionId}.jsonl`),
          onSpawn: (child) => {
            const entry = { child, dir };
            live.add(entry);
            if (shuttingDown) child.kill("SIGKILL");
            child.once("close", () => live.delete(entry));
          },
        });
        if (r.ok || shuttingDown) break;
        if (r.sessionMissing && mode === "resume" && !switched) {
          switched = true;
          log(`session が無いので新規に切り替え: kind=${kind} id=${id} old=${sessionId}`);
          sessionId = randomUUID();
          mode = "new";
          await writeState(dir, base());
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
      if (r.ok) {
        await writeState(dir, {
          session_id: sessionId,
          state: "idle",
          last_started_at: startedAt,
          last_finished_at: finished,
          retries: retriesUsed,
        });
        log(`claude 終了: kind=${kind} id=${id} session=${sessionId} ok=true ms=${r.durationMs} retries=${retriesUsed}`);
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
      log(`claude 終了: kind=${kind} id=${id} session=${sessionId} ok=false ms=${r.durationMs} retries=${retriesUsed} error=${detail}`);
      return { session_id: sessionId, ok: false, result_text: "", error: detail };
    } catch (e) {
      await markFailed(dir, errMsg(e));
      throw e;
    }
  }

  function invoke(kind: AgentKind, id: string, input: InvokeInput): Promise<RunOutcome> {
    if (!isValidAgentId(id)) {
      return Promise.reject(new Error(kind === "cap" ? `cap_id が不正: ${id}` : `worker_id が不正: ${id}`));
    }
    const key = `${kind}:${id}`;
    waiting.set(key, (waiting.get(key) ?? 0) + 1);
    const prev = chains.get(key) ?? Promise.resolve();
    const run = prev.then(() => {
      waiting.set(key, (waiting.get(key) ?? 1) - 1);
      return execute(kind, id, input);
    });
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

  async function statusOf(kind: AgentKind, id: string): Promise<AgentStatus> {
    const dir = agentDir(config.workspace, kind, id);
    const queued = waiting.get(`${kind}:${id}`) ?? 0;
    try {
      const s = await readState(dir);
      const out: AgentStatus = {
        kind,
        id,
        path: dir,
        session_id: s.session_id,
        state: s.state,
        last_started_at: s.last_started_at,
        last_finished_at: s.last_finished_at,
        retries: s.retries,
        queued,
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
    const sum: ReapSummary = { killed: 0, failed: 0, errored: 0 };
    let procs: LiveProcess[] | null | undefined;
    for (const kind of ["cap", "worker"] as const) {
      for (const id of await listIds(kind)) {
        try {
          const dir = agentDir(config.workspace, kind, id);
          let st: AgentStateFile;
          try {
            st = await readState(dir);
          } catch (e) {
            log(`孤児回収: state を読めない kind=${kind} id=${id}: ${errMsg(e)}`);
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
            log(`孤児回収: ps 不可 kind=${kind} id=${id}`);
            sum.errored++;
            continue;
          }
          const hit = st.session_id
            ? procs.filter((p) => p.pid !== process.pid && matchesSession(p.argv, st.session_id as string))
            : [];
          if (hit.length === 0) {
            await writeState(dir, next("failed", "前回の実行が終了しないまま server が落ちた"));
            log(`孤児回収: プロセス無し kind=${kind} id=${id} → failed`);
            sum.failed++;
            continue;
          }
          let allDead = true;
          for (const p of hit) {
            const dead = await terminate(p.pid).catch(() => false);
            log(`孤児回収: SIGKILL pid=${p.pid} kind=${kind} id=${id} dead=${dead}`);
            if (!dead) allDead = false;
          }
          if (allDead) {
            await writeState(dir, next("failed", "起動時に孤児プロセスを回収"));
            sum.killed++;
          } else {
            await writeState(dir, next("error", "孤児プロセスを止められない"));
            sum.errored++;
          }
        } catch (e) {
          log(`孤児回収: 失敗 kind=${kind} id=${id}: ${errMsg(e)}`);
          sum.errored++;
        }
      }
    }
    return sum;
  }

  async function shutdown(): Promise<void> {
    shuttingDown = true;
    const targets = [...live];
    for (const t of targets) t.child.kill("SIGKILL");
    for (const t of targets) await markFailed(t.dir, SHUTDOWN_MSG);
    await Promise.allSettled([...chains.values()]);
  }

  return { invoke, status, reapOrphans, shutdown };
}
