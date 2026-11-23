import { mkdir, rm, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { startBroker } from "@unagents/messenger-broker";
import { createMessengerClient } from "@unagents/messenger-client";
import type { InboundMessage, MessengerClient } from "@unagents/messenger-client";
import {
  MESSENGER_PROTOCOL,
  PROTOCOL_VERSION,
  SERVER_NAME,
  parseServerCommand,
  type ServerCommand,
  type ServerIdentityFields,
  type ServerBoard,
  type ServerReply,
  type UpdateProgress,
  type UpdateWaitRun,
} from "@agent-hand/bantou-protocol";
import { createActivityTracker } from "./activity";
import { createAgentManager, type ActiveRun, type AgentManager, type CloseResult, type InvokeInput, type RunExtras } from "./agents";
import { createWorkerCleaner } from "./cleanup";
import { DEFAULT_RESOURCE, loadConfig } from "./config";
import { buildIdentity, loadOrCreateServerId } from "./identity";
import { log } from "./log";
import { buildExtraMcp, writeMcpConfigFile } from "./extra-mcp";
import { CAP_ID_HEADER, CHANGE_ID_HEADER, TASK_ID_HEADER, WORKER_ID_HEADER, setPeerStatusHandler, type McpListener } from "./mcp";
import { buildBoard, buildPeerStatus } from "./board";
import { createResourceMonitor } from "./resources";
import { createReservationQueue } from "./reservations";
import { setBashWorkspace } from "./bash";
import { agentDir, laneDir, runLogDir } from "./paths";
import { CAP_GUIDE, WORKER_GUIDE, buildTaskPrompt, buildTaskResult } from "./prompts";
import { createReportHub, openAsksOfTask, setReportHandler } from "./reports";
import { createWorkerExitWatcher } from "./worker-exit";
import { EXIT_RETIRED, allowedWhileRetiring, createRetireController, detectService, retiringError } from "./retire";
import { cliRunner } from "./runner";
import {
  createUpdateController,
  removeReadyFile,
  removeUpdateFile,
  UpdateError,
  writeReadyFile,
  type UpdateController,
} from "./update";
import { createTaskScheduler, type TaskScheduler } from "./tasks";
import { readLaneMeta, writeLaneMeta } from "./lane-meta";
import { createWorkerHub, readOwner, readOwnerRecord, setWorkerHandler, writeOwner, type WorkerHub } from "./workers";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { prepareWorkspace } from "./workspace";
import { setChangeReportHandler } from "./change-bridge";
import { changeError, describeChangeCommand, executeChange, isChangeCommand } from "./change-commands";
import { createOpenspecMcpGate, createUnconfiguredGate } from "./change-gate";
import { createChangeNotifier } from "./change-notify";
import { createAdmission } from "./change-resources";
import { createChangeRunner } from "./change-runner";
import { createChangeStore } from "./change-store";

/** 返信に付ける messenger の meta（bantou protocol の登録と同じ値）。 */
export const REPLY_META = { protocol: MESSENGER_PROTOCOL.protocol, version: MESSENGER_PROTOCOL.version };

/** 受信 message の meta の扱い。bantou = bantou protocol、legacy = meta 無し（旧形式）、other = 他 protocol。 */
export function classifyMeta(meta: { protocol?: unknown; version?: unknown } | null | undefined): "bantou" | "legacy" | "other" {
  if (meta === undefined || meta === null) return "legacy";
  return meta.protocol === MESSENGER_PROTOCOL.protocol ? "bantou" : "other";
}

/** 無視ログ用に本文を 1 行・最大 120 文字へ整形する。 */
export function ignoreText(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 120);
}

/** 自分の broker へ接続する URL。全 IF bind の時は loopback。 */
export function brokerUrl(bind: string, port: number): string {
  const host = bind === "" || bind === "0.0.0.0" ? "127.0.0.1" : bind === "::" ? "::1" : bind;
  return `http://${host.includes(":") ? `[${host}]` : host}:${port}`;
}

/** ログ用に URL の userinfo（`://user:pass@`）を伏せる。 */
export function maskUserinfo(text: string): string {
  return text.replace(/:\/\/[^/\s"@]*@/g, "://***@");
}

/** 指示が指す cap_id。cap を指さない指示（hello / update_server / cap_id 無しの status など）は undefined。 */
export function commandCapId(cmd: ServerCommand): string | undefined {
  if (cmd.type === "task" || cmd.type === "kick_cap" || cmd.type === "stop_cap") return cmd.cap_id;
  // worker_reply / worker_stop は change の worker だと cap_id が無い
  if (cmd.type === "worker_reply" || cmd.type === "worker_stop") return cmd.cap_id;
  if (cmd.type === "status") return cmd.cap_id;
  return undefined;
}

/** 指示の概要。prompt は先頭 80 文字のみ、repo の userinfo は伏せる。 */
export function describeCommand(cmd: ServerCommand): string {
  if (cmd.type === "stop_cap") return `cap_id=${cmd.cap_id}`;
  if (cmd.type === "status") return cmd.cap_id ? `cap_id=${cmd.cap_id}` : "";
  if (cmd.type === "update_server") return `version=${cmd.version}`;
  if (cmd.type === "worker_reply") return `cap_id=${cmd.cap_id} worker_id=${cmd.worker_id} text=${ignoreText(cmd.text).slice(0, 80)}`;
  if (cmd.type === "worker_stop") return `cap_id=${cmd.cap_id} worker_id=${cmd.worker_id}${cmd.task_id ? ` task_id=${cmd.task_id}` : ""}`;
  if (cmd.type === "task") {
    const parts = [`cap_id=${cmd.cap_id}`, `task_id=${cmd.task_id}`];
    if (cmd.repo) parts.push(`repo=${maskUserinfo(cmd.repo)}`);
    if (cmd.branch) parts.push(`branch=${cmd.branch}`);
    if (cmd.worker_model) parts.push(`worker_model=${cmd.worker_model}`);
    parts.push(`workers=${cmd.workers.items?.length ?? 0}`);
    parts.push(`goal=${ignoreText(cmd.goal).slice(0, 80)}`);
    return parts.join(" ");
  }
  if (cmd.type !== "kick_cap") return "";
  const parts = [`cap_id=${cmd.cap_id}`];
  if (cmd.repo) parts.push(`repo=${maskUserinfo(cmd.repo)}`);
  if (cmd.branch) parts.push(`branch=${cmd.branch}`);
  // model / worker_model は protocol の版によって型に無い。無ければ付かないだけ
  const { model, worker_model: workerModel } = cmd as { model?: unknown; worker_model?: unknown };
  if (typeof model === "string" && model) parts.push(`model=${model}`);
  if (typeof workerModel === "string" && workerModel) parts.push(`worker_model=${workerModel}`);
  if (cmd.reason) parts.push(`reason=${ignoreText(cmd.reason)}`);
  parts.push(`prompt=${ignoreText(cmd.prompt).slice(0, 80)}`);
  return parts.join(" ");
}

/** status_result に載せる identity と版。 */
export type StatusIdentity = ServerIdentityFields & { server_version?: string; protocol_version?: string };

/** task の最初の指揮の run の入力（task の lane で動かす）。 */
export function taskInvokeInput(cmd: Extract<ServerCommand, { type: "task" }>, sameBranch: string[] = []): InvokeInput {
  // goal 等から定型の文面を組み立てて cap の最初の指示にする（buildTaskPrompt）。
  // repo / branch は cap には渡さない（cap は git を触らない。clone するのは worker）。文面に載せて cap から worker へ伝える
  // 同じ branch で終わっていない task があれば知らせる（server は待たせない。判断は cap）
  const notice =
    sameBranch.length > 0
      ? `\n\n[同じ branch の task]\n同じ cap の task（${sameBranch.join(", ")}）が、同じ push 先 branch（${cmd.deliverables?.branch ?? ""}）で動いている。server は待たせない。同時の push が衝突しないよう、branch の分け方や push の順序を worker への指示で決める。`
      : "";
  return {
    prompt: buildTaskPrompt(cmd) + notice,
    reason: `task ${cmd.task_id}`,
    ...(cmd.worker_model ? { worker_model: cmd.worker_model } : {}),
    taskId: cmd.task_id,
  };
}

/** 指示を実行して返信内容を作る。失敗は ErrorReply にする。 */
/** cap の worker への命令（worker_reply / worker_stop）の cap_id。change の worker（change_id）は execute に来ない。 */
function capOf(cmd: { cap_id?: string }): string {
  if (cmd.cap_id === undefined) throw new Error("cap_id が必要");
  return cmd.cap_id;
}

export async function execute(
  cmd: ServerCommand,
  manager: AgentManager,
  workers?: Pick<WorkerHub, "start"> & Partial<Pick<WorkerHub, "stop">>,
  /** status_result に載せる server の identity と版（protocol 1.7.0）。省略なら載せない（旧形式の返信）。 */
  identity?: StatusIdentity,
  /**
   * task の待ち行列。あれば task は task ごとの指揮（lane）で並行に動かし（上限・同じ branch は待たせる）、stop_cap は待っている task も止め、
   * status の cap に tasks を載せる。省略時は従来どおり cap の本体で 1 つずつ。
   */
  tasks?: Pick<TaskScheduler, "submit" | "stopCap" | "snapshot" | "waitingCount">,
  /** 掲示板と予約。board = status_result に載せる掲示板、dropReservations = stop_cap でその cap の予約を捨てる（捨てた件数を返す）。 */
  extra?: { board?: () => Promise<ServerBoard> | ServerBoard; dropReservations?: (capId: string) => number },
): Promise<ServerReply> {
  try {
    if (cmd.type === "kick_cap") {
      const r = await manager.invoke("cap", cmd.cap_id, cmd);
      return { bantou: PROTOCOL_VERSION, type: "cap_result", cap_id: cmd.cap_id, ...r };
    }
    if (cmd.type === "task") {
      if (tasks) {
        // 返信を送り終えるまで task を終わりにしない（daemon が送った後に replied を呼ぶ）
        const r = await tasks.submit(cmd, { deferReply: true });
        return buildTaskResult(cmd.cap_id, cmd.task_id, r);
      }
      const { taskId: _lane, ...input } = taskInvokeInput(cmd);
      const r = await manager.invoke("cap", cmd.cap_id, input);
      return buildTaskResult(cmd.cap_id, cmd.task_id, r);
    }
    if (cmd.type === "worker_reply") {
      if (!workers) throw new Error("server が起動中のため受け付けられない");
      // その worker を同じ worker_id で worker_start（持ち主の cap でなければ「別の cap の worker」で失敗）
      const r = await workers.start(capOf(cmd), { worker_id: cmd.worker_id, prompt: cmd.text });
      return { bantou: PROTOCOL_VERSION, type: "worker_reply_result", ok: true, cap_id: cmd.cap_id, worker_id: r.worker_id, accepted: true };
    }
    if (cmd.type === "worker_stop") {
      if (!workers?.stop) throw new Error("server が起動中のため受け付けられない");
      // 今の worker_stop の処理（workers.stop。cap の worker を止める / 予約を取り消す）にそのまま渡す
      const r = await workers.stop(capOf(cmd), cmd.worker_id, cmd.task_id);
      return { bantou: PROTOCOL_VERSION, type: "worker_stop_result", ok: true, cap_id: cmd.cap_id, worker_id: r.worker_id, stopped: r.stopped };
    }
    if (cmd.type === "stop_cap") {
      // 止めるだけでなく会話（session_id）も破棄する。次の task は新しい会話で始まる。
      // task の待ち行列があれば、待っている task も止め、閉じ終わるまでその cap の task を始めない
      const close = (): Promise<CloseResult> => manager.close("cap", cmd.cap_id);
      const { result: r, dropped: droppedTasks } = tasks ? await tasks.stopCap(cmd.cap_id, close) : { result: await close(), dropped: 0 };
      // その cap の worker の予約も捨てる
      const dropped = droppedTasks + (extra?.dropReservations?.(cmd.cap_id) ?? 0);
      return {
        bantou: PROTOCOL_VERSION,
        type: "stop_result",
        ok: true,
        cap_id: cmd.cap_id,
        // cap の run（task の指揮を含む）・待っている task・その cap の worker を 1 つでも止めたら true。worker の数は workers_stopped
        stopped: r.stopped || r.workers_stopped > 0 || dropped > 0,
        session_cleared: r.session_cleared,
        previous_session_id: r.previous_session_id,
        workers_stopped: r.workers_stopped,
      };
    }
    if (cmd.type === "resume_worker") {
      // worker は cap の依頼（/mcp の worker_start）で起動する。型は protocol に残るが center からの指示としては処理しない
      throw new Error("resume_worker は未対応");
    }
    if (cmd.type === "hello" || cmd.type === "update_server") {
      // daemon の handle が UpdateController で処理する。ここへは来ない
      throw new Error(`${cmd.type} は execute では処理しない`);
    }
    const st = await manager.status();
    // cap に task の状態（待ち・実行中・最近終わったもの。無ければ空）を載せ、まだ始まっていない task を queued に足す。
    // 空でも載せる（center は tasks があれば task_id で受付を確かめる）
    const caps = tasks ? st.caps.map((c) => ({ ...c, queued: c.queued + tasks.waitingCount(c.id), tasks: tasks.snapshot(c.id) })) : st.caps;
    const board = extra?.board ? await extra.board() : undefined;
    return { bantou: PROTOCOL_VERSION, type: "status_result", ok: true, ...(identity ?? {}), caps, workers: st.workers, ...(board !== undefined ? { board } : {}) };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    log(`エラー: ${cmd.type}: ${message}`);
    const id =
      cmd.type === "task"
        ? { cap_id: cmd.cap_id, task_id: cmd.task_id }
        : cmd.type === "worker_reply" || cmd.type === "worker_stop"
          ? { cap_id: cmd.cap_id, worker_id: cmd.worker_id }
          : cmd.type === "kick_cap" || cmd.type === "stop_cap"
            ? { cap_id: cmd.cap_id }
            : {};
    return { bantou: PROTOCOL_VERSION, type: "error", ok: false, message, command: cmd.type, ...id };
  }
}

/** 待っている run を短く並べる上限。 */
const WAIT_RUNS_IN_MESSAGE = 5;

const minutesSince = (iso: string | undefined, nowMs: number): number | undefined => {
  if (iso === undefined) return undefined;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? undefined : Math.max(0, Math.floor((nowMs - t) / 60_000));
};

/**
 * 更新が何を待っているかの一文（server の断りと center の表示で同じ形）。
 * 例: 「待機 12 分、2026-11-21T14:40:00.000Z（上限）に残りを止めて再起動。待っている run: cap 1 / worker 2（cap:c-1 実行 8 分、worker:w-2[cap c-1] 実行 3 分）」
 * 経過と上限を先に置く（表示で長さを切られても残るように）。
 */
export function describeUpdateWait(update: UpdateProgress, nowMs = Date.now()): string {
  const r = update.running;
  const runs = update.runs ?? [];
  const items = runs.slice(0, WAIT_RUNS_IN_MESSAGE).map((x) => {
    const m = minutesSince(x.started_at, nowMs);
    const owner = (x.kind === "worker" && x.cap_id ? `[cap ${x.cap_id}]` : "") + (x.task_id ? `[task ${x.task_id}]` : "");
    return `${x.kind}:${x.id}${owner} ${PHASE_WORD[x.phase] ?? String(x.phase)}${m !== undefined ? ` ${m} 分` : ""}`;
  });
  const more = runs.length > WAIT_RUNS_IN_MESSAGE ? ` ほか ${runs.length - WAIT_RUNS_IN_MESSAGE} 件` : "";
  const head = `待っている run: cap ${r.caps} / worker ${r.workers}${items.length > 0 ? `（${items.join("、")}${more}）` : ""}`;
  const waited = minutesSince(update.since, nowMs);
  const tail = [
    waited !== undefined ? `待機 ${waited} 分` : undefined,
    update.deadline !== undefined ? `${update.deadline}（上限）に残りを止めて再起動` : undefined,
  ].filter((x) => x !== undefined);
  return `${tail.length > 0 ? `${tail.join("、")}。` : ""}${head}`;
}

const PHASE_WORD: Partial<Record<string, string>> & Record<UpdateWaitRun["phase"], string> = { running: "実行", preparing: "準備", queued: "待ち" };

/** 更新待機中に断る kick_cap / task の error。center は同じ指示を再送できる。何を待っているか（update）を載せる。 */
export function updatingError(
  cmd: { cap_id: string; task_id?: string },
  update: { from: string; to: string } | UpdateProgress,
): ServerReply {
  const progress = "running" in update ? update : undefined;
  return {
    bantou: PROTOCOL_VERSION,
    type: "error",
    ok: false,
    message:
      `server 更新待ち（${update.from}→${update.to}）。実行中の cap/worker の終了後に再起動する。再起動後に再送` +
      (progress ? `。${describeUpdateWait(progress)}` : ""),
    command: cmd.task_id !== undefined ? "task" : "kick_cap",
    cap_id: cmd.cap_id,
    ...(cmd.task_id !== undefined ? { task_id: cmd.task_id } : {}),
    code: "updating",
    retryable: true,
    ...(progress ? { update: progress } : {}),
  };
}

/** hello / update_server を UpdateController で処理して返信を作る。 */
export async function executeUpdate(cmd: ServerCommand, update: UpdateController): Promise<ServerReply> {
  if (cmd.type === "hello") return update.hello();
  if (cmd.type !== "update_server") throw new Error(`更新系でない指示: ${cmd.type}`);
  try {
    return await update.request(cmd.version);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    log(`エラー: ${cmd.type}: ${message}`);
    if (e instanceof UpdateError) {
      return { bantou: PROTOCOL_VERSION, type: "error", ok: false, message, command: cmd.type, code: e.code, retryable: e.retryable };
    }
    return { bantou: PROTOCOL_VERSION, type: "error", ok: false, message, command: cmd.type };
  }
}

/** 起動済みの daemon。stop は実行中の claude・peer・broker を止める（プロセス終了は呼び出し側）。 */
export interface Daemon {
  stop(): Promise<void>;
  /** process の終了コード。退役を受けた後は EXIT_RETIRED（launcher・systemd が再起動しない）、それ以外は 0。 */
  exitCode(): number;
}

/** daemon が使う外部資源。/mcp の listener は Nitro の h3App が要るので plugin から渡す。 */
export interface DaemonDeps {
  /** bantou protocol 定義（protocol.json を含む dir）。空なら protocol 登録を行わず名前待受のみ。 */
  protocolDir?: string;
  startMcp: (opts: { port: number; bind: string }) => Promise<McpListener>;
  /** 自分の npm 版（hello_result の server_version、更新先との比較）。未指定は "unknown"。 */
  serverVersion?: string;
  /** 更新のための終了を頼む（plugin の shutdown）。未指定なら更新は受け付けるが再起動できない。 */
  requestExit?: (reason: string) => void;
  /** 更新先の取得確認（テスト用に差し替える。既定は npx）。 */
  updateFetch?: (spec: string, version: string) => Promise<void>;
  /** 待機中の監視間隔 ms（テスト用）。 */
  updatePollMs?: number;
}

/** 設定を読み込んで起動し、常駐物を返す。シグナルと exit は呼び出し側（plugin）が担う。 */
export async function startDaemon(configPath: string, deps: DaemonDeps): Promise<Daemon> {
  log("起動");
  const config = await loadConfig(configPath);
  log(`設定読込: ${configPath} (workspace=${config.workspace})`);
  const dirs = await prepareWorkspace(config.workspace);
  log(`workspace 準備完了: caps=${dirs.caps} workers=${dirs.workers}`);
  // 安定した server の id（<workspace>/server.json）。再起動・自己更新でも同じ workspace なら変わらない
  const identity = buildIdentity(await loadOrCreateServerId(config.workspace, log), config.workspace);
  log(`server_id=${identity.server_id} host=${identity.host} user=${identity.user}`);
  // /mcp が立つ前は run が起きない（reapOrphans は run しない）。runExtras はその後の値を使う
  let mcpUrl: string | undefined;
  const tracker = createActivityTracker({
    notify: (capId, notice) => hub.notify(capId, notice),
    log,
    tasksOf: (capId) => scheduler.snapshot(capId),
  });
  const runExtras = async (kind: "cap" | "worker", id: string, input: { capId?: string; taskId?: string; changeId?: string }): Promise<RunExtras> => {
    if (!mcpUrl) throw new Error("mcp が未起動");
    // cap の task の lane は、mcp 設定・system prompt を lane の logs/ に書く（lane ごとに header の task_id が違う）
    const dir = kind === "cap" && input.taskId !== undefined ? laneDir(config.workspace, id, input.taskId) : agentDir(config.workspace, kind, id);
    const headers: Record<string, string> = {};
    if (kind === "cap") {
      headers[CAP_ID_HEADER] = id;
      if (input.taskId !== undefined) headers[TASK_ID_HEADER] = input.taskId;
    } else if (input.changeId !== undefined) {
      // 新しい経路（change）の worker: 持ち主は change。cap-id は付けない（report は change-id と worker-id で受ける）
      headers[CHANGE_ID_HEADER] = input.changeId;
      headers[WORKER_ID_HEADER] = id;
    } else {
      const owner = await readOwnerRecord(config.workspace, id);
      const capId = input.capId ?? owner?.capId;
      if (!capId) throw new Error(`worker の持ち主 cap が分からない: ${id}`);
      await writeOwner(config.workspace, id, capId, input.taskId ?? (owner?.capId === capId ? owner.taskId : undefined));
      headers[CAP_ID_HEADER] = capId;
      headers[WORKER_ID_HEADER] = id;
    }
    // 引数に本文を直書きすると " -- " を含む時に孤児回収が照合できなくなるのでファイルで渡す（claude.ts）
    const logs = runLogDir(dir);
    await mkdir(logs, { recursive: true });
    const mcpConfigFile = join(logs, "mcp.json");
    const appendSystemPromptFile = join(logs, "system-prompt.md");
    const extra = buildExtraMcp(config.extraMcp ?? {}, kind, log);
    const mcpServers = { bantou: { type: "http", url: mcpUrl, headers }, ...extra.servers };
    // extraMcp の env を含みうるので本人だけが読める mode で書く
    await writeMcpConfigFile(mcpConfigFile, { mcpServers });
    await writeFile(appendSystemPromptFile, (kind === "cap" ? CAP_GUIDE : WORKER_GUIDE) + "\n");
    return {
      mcpConfigFile,
      appendSystemPromptFile,
      extraAllowedTools:
        kind === "cap"
          ? ["mcp__bantou__worker_start", "mcp__bantou__worker_status", "mcp__bantou__worker_stop", "mcp__bantou__bash", ...extra.allowedTools]
          : ["mcp__bantou__report", "mcp__bantou__bash", ...extra.allowedTools],
    };
  };
  // worker の終了（失敗・時間切れ・done 無し）は、activity を出す前に cap の再開を積む（watcher が tracker を包む）。hub は後で作る
  const exitWatcher = createWorkerExitWatcher({
    workspace: config.workspace,
    maxResumes: config.session.exitResumeMax,
    recoverMs: config.session.exitRecoverMs,
    resumeCap: (capId, prompt, reason, taskId) => hub.resumeCap(capId, prompt, reason, taskId),
    failTask: (capId, message, taskId) => {
      // task の worker なら、その task を失敗で終える印も付ける（返信を送り終えてから終わりになる）
      if (taskId !== undefined) scheduler.fail(capId, taskId, message);
      return hub.failTask(capId, message, taskId);
    },
    knownTask: (capId) => hub.knownTask(capId),
    taskId: (capId) => hub.taskId(capId),
    holdCap: (capId, taskId) => tracker.holdCap(capId, taskId),
    releaseCap: (capId, taskId) => tracker.releaseCap(capId, taskId),
    capOf: (workerId) => tracker.snapshot().find((a) => a.kind === "worker" && a.id === workerId)?.cap_id,
    isClosed: (capId) => manager.isClosed(capId),
    log,
  });
  const manager = createAgentManager({
    config,
    runner: cliRunner,
    log,
    observer: exitWatcher.wrap(tracker),
    runExtras,
    // task の run（指揮・worker）が載った・終わった: task の状態を追う
    onRunAdded: (run) => {
      if (run.taskId !== undefined && run.capId !== undefined) scheduler.touch(run.capId, run.taskId);
    },
    onRunSettled: (run, result) => {
      if (run.kind === "cap" && run.taskId !== undefined) scheduler.noteOutcome(run.id, run.taskId, result);
      scheduler.check();
    },
  });
  /**
   * worker の開始の予約（cap が資源が足りないと判断して reserve を付けたもの）。来た順に貯め、worker が 1 本終わるたびに先頭を 1 本起こす。
   * 動いている worker が 0 本の時に来たらすぐ起こす。ファイルに残す（再起動の後も有効）。
   */
  const reservations = createReservationQueue({
    file: join(config.workspace, "reservations.json"),
    running: () => manager.activeCount().workers,
    launch: (r) => workerHub.launchReserved(r),
    changed: (capId) => tracker.touch(capId),
    log,
  });
  /** host の資源の測定（掲示のためだけ。閾値は持たない）。 */
  const resources = createResourceMonitor({
    dir: config.workspace,
    workers: () => manager.activeCount().workers,
    sampleMs: config.resource?.sampleMs ?? DEFAULT_RESOURCE.sampleMs,
    log,
  });
  /**
   * task の待ち行列。task ごとに指揮（lane）を立てて並行に動かす。並行の上限は無い（利用者が session.maxParallelTasks を置いた時だけ効く）。
   * 同じ deliverables.branch の task も待たせず、cap に知らせる。task が終わる = 指揮・worker・予約・report 起因の処理が全部無くなった時。
   */
  const scheduler: TaskScheduler = createTaskScheduler({
    ...(config.session.maxParallelTasks !== undefined ? { maxParallel: config.session.maxParallelTasks } : {}),
    run: (cmd, info) => manager.invoke("cap", cmd.cap_id, taskInvokeInput(cmd, info.sameBranch)),
    busy: (capId, taskId) => manager.laneBusy(capId, taskId) || hub.pendingFor(capId, taskId) > 0 || reservations.reservedFor(capId, taskId) > 0,
    changed: (capId) => tracker.touch(capId),
    saveMeta: (cmd, meta) => writeLaneMeta(laneDir(config.workspace, cmd.cap_id, cmd.task_id), { task_id: cmd.task_id, ...meta, prompt: taskInvokeInput(cmd).prompt }),
    loadMeta: async (capId, taskId) => {
      const m = await readLaneMeta(laneDir(config.workspace, capId, taskId));
      return m === undefined ? undefined : m.branch !== undefined ? { branch: m.branch } : {};
    },
    // task が終わったら lane の mcp.json（extraMcp の env を含みうる）を消す。再開されたら run の前に書き直す
    onFinished: (capId, taskId) => {
      void removeLaneMcp(capId, taskId);
    },
    // 終わってから workerKeepMs（worker の掃除と同じ時機）再開されなかった lane は片付ける（0 は片付けない）
    retireMs: config.session.workerKeepMs,
    // ask / approve に答えてもらっていない worker がいる task の lane は片付けない（答えた後、また終わってから数え直す）
    retire: async (capId, taskId) => ((await openAsksOfTask(config.workspace, capId, taskId)).length > 0 ? false : manager.retireLane(capId, taskId)),
    forgetLane: (capId, taskId) => {
      tracker.forgetLane(capId, taskId);
      exitWatcher.forgetLane(capId, taskId);
    },
    log,
  });
  /** lane の mcp.json を消す（無ければ何もしない）。 */
  const removeLaneMcp = (capId: string, taskId: string): Promise<void> =>
    rm(join(runLogDir(laneDir(config.workspace, capId, taskId)), "mcp.json"), { force: true }).catch((e: unknown) =>
      log(`lane の mcp.json を消せない: cap_id=${capId} task_id=${taskId} ${e instanceof Error ? e.message : String(e)}`),
    );
  log(`task の同時実行の上限: ${config.session.maxParallelTasks !== undefined ? `cap ごとに ${config.session.maxParallelTasks}（利用者の設定）` : "なし"}（同じ deliverables.branch の task も待たせず、cap に知らせる）`);
  const cleaner = createWorkerCleaner({
    workspace: config.workspace,
    keepMs: config.session.workerKeepMs,
    snapshot: () => tracker.snapshot(),
    capEntry: (capId, taskId) => tracker.capEntry(capId, taskId),
    isActive: (id) => manager.isActive("worker", id),
    forget: (id) => tracker.forget("worker", id),
    log,
  });
  const workerHub = createWorkerHub({ workspace: config.workspace, manager, activity: tracker, log, cleaner, taskActive: (capId, taskId) => scheduler.isActive(capId, taskId), reservations });
  /** server の掲示板（cap・worker の数・資源・予約の件数。数と資源だけ）。 */
  const buildServerBoard = async (): Promise<ServerBoard> => {
    const st = await manager.status();
    return buildBoard({
      caps: st.caps,
      activity: tracker.snapshot(),
      workers: manager.activeCount().workers,
      taskCounts: (capId) => {
        const t = scheduler.snapshot(capId);
        return { running: t.filter((x) => x.state === "running").length, waiting: t.filter((x) => x.state === "waiting").length };
      },
      reservedOf: (capId) => reservations.count(capId),
      reservedTotal: reservations.count(),
      resources: resources.latest(),
      maxParallelTasks: config.session.maxParallelTasks,
    });
  };
  const reaped = await manager.reapOrphans();
  log(`孤児回収: killed=${reaped.killed} failed=${reaped.failed} error=${reaped.errored}`);
  // 閉じた cap の印（再起動をまたぐ）。worker の終了の回収（exitWatcher.recover）より前に読む
  const closedCount = await manager.loadClosed().catch((e: unknown) => {
    log(`閉じた cap の印を読めない: ${e instanceof Error ? e.message : String(e)}`);
    return 0;
  });
  if (closedCount > 0) log(`閉じた cap: ${closedCount} 件（worker の report / 終了で起こさない）`);
  // 前回までに終わった task の lane: mcp.json を消し、片付けの対象に入れる
  try {
    const idle = await manager.idleLanes();
    for (const l of idle) await removeLaneMcp(l.capId, l.taskId);
    scheduler.adoptIdle(idle);
    if (idle.length > 0) log(`終わった task の lane: ${idle.length} 件（workerKeepMs の後に片付ける）`);
  } catch (e) {
    log(`終わった task の lane を拾えない: ${e instanceof Error ? e.message : String(e)}`);
  }

  const { port: wantPort, bind, discovery, token } = config.broker;
  const broker = await startBroker({
    port: wantPort,
    bind,
    token,
    discovery: discovery === "on",
    stateFile: join(config.workspace, "broker.json"),
  });
  log(
    `broker 起動: port=${broker.port} bind=${bind} discovery=${discovery} token=${token ? "有" : "無"} id=${broker.id}`,
  );
  if (!["127.0.0.1", "::1", "localhost"].includes(bind) && token === "") {
    log(`警告: token 無しで ${bind} に bind。LAN から誰でも指示を送れる`);
  }

  let mcp: McpListener;
  try {
    mcp = await deps.startMcp(config.mcp);
  } catch (e) {
    await broker.close().catch(() => {});
    throw e;
  }
  mcpUrl = `${brokerUrl(config.mcp.bind, mcp.port)}/mcp`;
  log(`mcp 起動: url=${mcpUrl} bind=${config.mcp.bind}`);

  let closing = false;
  /**
   * kick_cap / task の受け付けから返信までの件数（cap ごと）。更新の再起動を待たせるのは、manager にまだ載っていない
   * （受け付けの直後・run の後の返信の送信中）の分だけ。載っている間は manager の activeRuns（生きている run）が決める。
   */
  const kicking = new Map<string, number>();
  /**
   * 更新が待つ run: 生きている（または準備中の）run のうち、閉じた cap の worker を除く（閉じた cap は起こさないので、その worker の結果を待つ者は居ない）。
   * task の待ち行列の、まだ始まっていない task（queued）と、最初の返信を送っている task（preparing）も cap の run として数える。
   */
  const waitRuns = (): ActiveRun[] => [
    ...manager.activeRuns().filter((r) => !(r.kind === "worker" && r.capId !== undefined && manager.isClosed(r.capId))),
    ...scheduler.waitRuns().map((t): ActiveRun => ({ kind: "cap", id: t.capId, taskId: t.taskId, startedAt: t.since, phase: t.phase })),
  ];
  const serverVersion = deps.serverVersion ?? "unknown";
  const update = createUpdateController({
    workspace: config.workspace,
    serverVersion,
    identity,
    specTemplate: config.update.spec,
    running: () => {
      const runs = waitRuns();
      return { caps: runs.filter((r) => r.kind === "cap").length, workers: runs.filter((r) => r.kind === "worker").length, reports: hub.pendingCount() };
    },
    runs: () =>
      waitRuns().map((r) => ({
        kind: r.kind,
        id: r.id,
        ...(r.capId !== undefined && r.kind === "worker" ? { cap_id: r.capId } : {}),
        ...(r.taskId !== undefined ? { task_id: r.taskId } : {}),
        started_at: r.startedAt,
        phase: r.phase,
      })),
    extraBusy: () => [...kicking.keys()].filter((capId) => !manager.isActive("cap", capId) && !scheduler.has(capId)).length,
    maxWaitMs: config.update.maxWaitMs,
    fetch: deps.updateFetch,
    requestExit: (reason) => (deps.requestExit ?? (() => log("終了を頼む先が無いため再起動できない")))(reason),
    log,
    pollMs: deps.updatePollMs,
  });
  await update.loadLastFailure();
  let client!: MessengerClient;
  let protocolSet = false;
  const hub = createReportHub({
    workspace: config.workspace,
    invoke: (capId, input) => manager.invoke("cap", capId, input),
    // report の worker の task（持ち主の記録）。その task の指揮を再開し、worker_report の task_id にする
    laneOf: async (capId, workerId) => {
      const owner = await readOwnerRecord(config.workspace, workerId);
      return owner?.capId === capId ? owner.taskId : undefined;
    },
    onLaneSettled: () => scheduler.check(),
    send: async (to, reply) => {
      await client.send(to, JSON.stringify(reply), "pull", REPLY_META);
    },
    // center は名前（bantou-center）で覚え、送る時に今の peer id へ引く（center の再起動で peer id が変わる）
    resolvePeers: async (name) => {
      const own = client.peer.id;
      return (await client.listPeers("all")).filter((p) => p.name === name && p.id !== own).map((p) => ({ id: p.id, registered_at: p.registered_at }));
    },
    log,
  });
  /**
   * change 単位の step 消化（新しい経路。remote-cap の経路とは別に並べる）。記録は <workspace>/changes/。
   * 起こしてよいかは config.change の値（M3。省略は上限なし）と resources の測定値で server が判定する。
   */
  const changeGate = config.openspecMcp ? createOpenspecMcpGate(config.openspecMcp) : createUnconfiguredGate();
  const changeRunner = createChangeRunner({
    store: createChangeStore(config.workspace, log),
    gate: changeGate,
    admission: createAdmission(config.change ?? {}, () => resources.latest()),
    launch: async (req) => {
      const r = await manager.invoke("worker", req.worker_id, {
        prompt: req.prompt,
        repo: req.repo,
        ...(req.branch !== undefined ? { branch: req.branch } : {}),
        ...(req.model !== undefined ? { defaultModel: req.model } : {}),
        reason: `change ${req.change_id} step ${req.step}`,
        changeId: req.change_id,
      });
      return { ok: r.ok, session_id: r.session_id, ...(r.error !== undefined ? { error: r.error } : {}) };
    },
    stopWorker: (workerId) => manager.stop("worker", workerId),
    notify: createChangeNotifier({
      resolvePeers: async (name) => {
        const own = client.peer.id;
        return (await client.listPeers("all")).filter((p) => p.name === name && p.id !== own).map((p) => ({ id: p.id, registered_at: p.registered_at }));
      },
      send: async (to, notice) => {
        await client.send(to, JSON.stringify(notice), "pull", REPLY_META);
      },
      log,
    }),
    log,
  });
  // 資源が空くのを待っている queue を、測定の周期で見直す（周期は resource.sampleMs。新しい値は足さない）
  const changePump = setInterval(() => changeRunner.pump(), config.resource?.sampleMs ?? DEFAULT_RESOURCE.sampleMs);
  changePump.unref();
  // 退役（retire_server）。受付停止 → cap / worker 停止 → 返信 → messenger 解除 → exit 76
  const retire = createRetireController({
    workspace: config.workspace,
    identity,
    count: () => {
      const c = manager.activeCount();
      return { caps: c.caps + scheduler.waitingCount(), workers: c.workers };
    },
    cancelUpdate: () => update.close(),
    clearUpdateFile: () => removeUpdateFile(config.workspace),
    refuse: () => {
      // worker_start / report は /mcp 側の handler で断る（実行中の cap / worker は stopAll が止める）
      setWorkerHandler({
        start: async () => {
          throw new Error("server は退役中のため worker を起動できない");
        },
        status: (capId, workerId) => workerHub.status(capId, workerId),
        stop: (capId, workerId) => workerHub.stop(capId, workerId),
      });
      setReportHandler(async () => {
        throw new Error("server は退役中のため report を受け付けない");
      });
      setChangeReportHandler(async () => {
        throw new Error("server は退役中のため report を受け付けない");
      });
    },
    stopAll: async () => {
      scheduler.close("server は退役中のため止めた");
      changeRunner.close();
      await manager.shutdown();
    },
    finish: () => (deps.requestExit ?? (() => log("終了を頼む先が無いため終了できない")))("retire"),
    service: () => {
      let cgroup: string | undefined;
      try {
        cgroup = readFileSync("/proc/self/cgroup", "utf8");
      } catch {
        cgroup = undefined;
      }
      return detectService({ platform: process.platform, env: process.env, cgroup });
    },
    home: homedir(),
    log,
  });
  // 実行中の指示。claude の実行は数分かかるので全体は直列にしない。
  // 同一 agent の直列化は manager の queue が担い、別 agent は並行して走る
  const inflight = new Set<Promise<void>>();
  /** cap ごとの task の受け付けの順番（受けた順に待ち行列へ入れる）。 */
  const accepting = new Map<string, Promise<void>>();

  const handle = async (m: InboundMessage): Promise<void> => {
    let counted: string | undefined;
    try {
      if (m.mode === "ping") return;
      const from = `${m.from_name}(${m.from_id})`;
      if (classifyMeta(m.meta) === "other") {
        log(`無視(他 protocol): from=${from} protocol=${String(m.meta?.protocol)}`);
        return;
      }
      const cmd = parseServerCommand(m.text);
      if (!cmd) {
        log(`無視: from=${from} text=${ignoreText(m.text)}`);
        return;
      }
      if (closing) {
        log(`終了中のため無視: from=${from} type=${cmd.type}`);
        return;
      }
      log(`指示受信: type=${cmd.type} from=${from} ${isChangeCommand(cmd) ? describeChangeCommand(cmd) : describeCommand(cmd)}`.trimEnd());
      let reply: ServerReply;
      if (cmd.type === "retire_server") {
        reply = await retire.request(cmd, from);
      } else if (retire.isRetiring() && !allowedWhileRetiring(cmd)) {
        // 退役中は新しい指示を断る（再送しても通らない）
        reply = retiringError(cmd);
      } else if (cmd.type === "hello" || cmd.type === "update_server") {
        reply = await executeUpdate(cmd, update);
      } else if (isChangeCommand(cmd)) {
        // 新しい経路（change の登録と、change の worker への worker_reply / worker_stop）。更新待機中は登録だけ断る（再起動後に再送できる）。返答・停止は通す
        if (cmd.type === "register_change" && update.isUpdating()) {
          const p = update.progress();
          reply = changeError(cmd, `server 更新待ち（${p?.from ?? serverVersion}→${p?.to ?? "?"}）。再起動後に再送`, { code: "updating", retryable: true });
        } else {
          reply = await executeChange(cmd, { runner: changeRunner, from: { id: m.from_id, ...(m.from_name ? { name: m.from_name } : {}) } });
        }
      } else if ((cmd.type === "kick_cap" || cmd.type === "task") && update.isUpdating()) {
        // 更新待機中は新しい指示を受け付けず、理由付きで断る（center は再起動後に再送できる）
        const p = update.progress();
        reply = updatingError(cmd.type === "task" ? { cap_id: cmd.cap_id, task_id: cmd.task_id } : cmd, p ?? { from: serverVersion, to: "?" });
        // 断っても、通知先は今の center にしておく（cap が動いていれば、その通知は今の center へ）
        await hub.noteCenter(cmd.cap_id, m.from_id, m.from_name || undefined);
      } else {
        // task は受けた順に待ち行列へ入れる（同じ branch の task は先に来た方から動く）。受け付けの記録（await）の間に後の task が追い越さないよう、cap ごとに順に通す
        let accepted: (() => void) | undefined;
        if (cmd.type === "task") {
          const before = accepting.get(cmd.cap_id) ?? Promise.resolve();
          const mine = new Promise<void>((r) => (accepted = r));
          const tail = before.then(() => mine);
          accepting.set(cmd.cap_id, tail);
          void tail.then(() => {
            if (accepting.get(cmd.cap_id) === tail) accepting.delete(cmd.cap_id);
          });
          await before;
        }
        try {
          if (cmd.type === "kick_cap" || cmd.type === "task") {
            kicking.set(cmd.cap_id, (kicking.get(cmd.cap_id) ?? 0) + 1);
            counted = cmd.cap_id;
            // 以降この cap の結果（report 起因の resume を含む）はこの center へ返す。名前で覚える（peer id は center の再起動で変わる）
            await hub.rememberCenter(cmd.cap_id, m.from_id, m.from_name || undefined);
            // 以降の worker_report と report 起因の task_result はこの task_id を付ける
            if (cmd.type === "task") await hub.rememberTask(cmd.cap_id, cmd.task_id);
          }
          // cap を指す他の命令（status・stop_cap・worker_reply）の送信元も通知先にする（center の再起動後に通知先を取り戻す）
          const capId = commandCapId(cmd);
          if (capId !== undefined && cmd.type !== "kick_cap" && cmd.type !== "task") await hub.noteCenter(capId, m.from_id, m.from_name || undefined);
          // execute は task を同期で待ち行列へ入れる（submit）。入れた所で次の task の受け付けを通す
          const running = execute(cmd, manager, workerHub, { ...identity, server_version: serverVersion, protocol_version: MESSENGER_PROTOCOL.version }, scheduler, {
            board: buildServerBoard,
            dropReservations: (id) => reservations.dropCap(id),
          });
          accepted?.();
          reply = await running;
        } finally {
          accepted?.();
        }
      }
      try {
        await client.send(m.from_id, JSON.stringify(reply), "pull", REPLY_META);
        log(`返信: to=${m.from_id} type=${reply.type} meta=${REPLY_META.protocol}@${REPLY_META.version}`);
      } catch (e) {
        log(`返信失敗: to=${m.from_id} ${e instanceof Error ? e.message : String(e)}`);
      }
      // 退役の返信を出し終えた（失敗でも）。猶予の後に messenger を解除して終了する
      if (cmd.type === "retire_server") retire.replied();
      // task の最初の返信を出し終えた（失敗でも）。以後、その task は指揮・worker が無くなった時に終わる
      if (cmd.type === "task") scheduler.replied(cmd.cap_id, cmd.task_id);
    } catch (e) {
      log(`エラー: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      // 返信を出し切るまで更新の再起動を待たせる
      if (counted !== undefined) {
        const n = (kicking.get(counted) ?? 1) - 1;
        if (n > 0) kicking.set(counted, n);
        else kicking.delete(counted);
      }
    }
  };

  try {
    // 接続先は agent-messenger の通常の解決（env → config → UDP 発見 → ローカル fallback）に任せる。
    // 自前 broker の URL は指名しない。解決結果は messenger のログ（broker=... via ...）に出る
    client = createMessengerClient({
      name: SERVER_NAME,
      summary: `${hostname()} ${config.workspace}`,
      autoStartBroker: false,
      log: (m) => log(`messenger: ${m}`),
    });
    client.onMessage((m) => {
      const p: Promise<void> = handle(m).finally(() => inflight.delete(p));
      inflight.add(p);
    });
    await client.connect();
    log(`peer 登録: name=${SERVER_NAME} id=${client.peer.id}`);
    if (deps.protocolDir) {
      // 失敗しても致命にしない（従来の名前待受 bantou-server で継続する）
      try {
        const info = await client.setProtocol(deps.protocolDir);
        protocolSet = true;
        log(`protocol 登録: ${info.name}@${info.version} hash=${info.hash} dir=${deps.protocolDir}`);
      } catch (e) {
        log(`protocol 登録失敗（名前待受 ${SERVER_NAME} で継続）: ${e instanceof Error ? e.message : String(e)}`);
      }
    } else {
      log(`protocol 未指定のため登録しない（名前待受 ${SERVER_NAME} のみ）`);
    }
  } catch (e) {
    await mcp.close().catch(() => {});
    await broker.close().catch(() => {});
    throw e;
  }
  setReportHandler((capId, workerId, kind, text) => {
    tracker.reported(workerId, kind);
    exitWatcher.reported(workerId, kind, new Date().toISOString());
    return hub.report(capId, workerId, kind, text);
  });
  setChangeReportHandler((changeId, workerId, kind, text) => changeRunner.reported(changeId, workerId, kind, text));
  setWorkerHandler(workerHub);
  setPeerStatusHandler(async (capId) => {
    // cap が見る時は今測る（掲示の周期を待たない）
    await resources.sample().catch(() => undefined);
    return buildPeerStatus(capId, await buildServerBoard(), (id) => manager.isActive("cap", id));
  });
  setBashWorkspace(config.workspace);
  // 前回の予約を読み込む（動いている worker が 0 本なら先頭をすぐ起こす）
  await reservations.load();
  // 前回の change の記録を読み、中断していた step を続ける
  log(`change の記録: ${await changeRunner.load()} 件`);
  // 起動時に回収した running は lost として center へ知らせる
  for (const r of reaped.reaped) {
    const capId = r.kind === "cap" ? r.id : await readOwner(config.workspace, r.id);
    if (capId) tracker.seedLost(r.kind, r.id, capId, r.error, r.kind === "cap" ? r.taskId : undefined);
  }
  // 再起動前に終わっていて、cap に知らせていない worker の終了を 1 回だけ拾う
  void exitWatcher.recover().then((n) => log(`終了した worker の回収: cap 再開=${n}`), (e: unknown) => log(`終了した worker の回収に失敗: ${e instanceof Error ? e.message : String(e)}`));

  const stop = async (): Promise<void> => {
    if (closing) return;
    closing = true;
    try {
      // 実行中の claude を止め、中断の返信を出し切るのを少し待つ
      setReportHandler(undefined);
      setChangeReportHandler(undefined);
      clearInterval(changePump);
      changeRunner.close();
      setWorkerHandler(undefined);
      setPeerStatusHandler(undefined);
      resources.close();
      setBashWorkspace(undefined);
      hub.close();
      scheduler.close("server 終了により中断");
      await manager.shutdown();
      await Promise.race([
        Promise.allSettled([...inflight, hub.drain()]),
        new Promise((r) => setTimeout(r, 2500)),
      ]);
      await cleaner.close();
      tracker.close();
      update.close();
      await removeReadyFile(config.workspace).catch(() => {});
      if (protocolSet) {
        await client.unsetProtocol().then(
          () => log("protocol 解除"),
          (e: unknown) => log(`protocol 解除失敗: ${e instanceof Error ? e.message : String(e)}`),
        );
      }
      await client.close();
      await mcp.close();
      log("mcp 停止");
      await broker.close();
      log("broker 停止");
    } catch (e) {
      log(`終了処理エラー: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
  // supervisor への「起動できた」合図（更新後の子はこれが無いと巻き戻される）
  await writeReadyFile(config.workspace, serverVersion).catch((e: unknown) =>
    log(`server.ready を書けない: ${e instanceof Error ? e.message : String(e)}`),
  );
  log(`常駐開始: version=${serverVersion}`);
  return { stop, exitCode: () => (retire.isRetiring() ? EXIT_RETIRED : 0) };
}
