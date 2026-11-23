import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, readdir } from "node:fs/promises";
import { hostname, loadavg } from "node:os";
import { join } from "node:path";
import { startBroker } from "@unagents/messenger-broker";
import { createMessengerClient } from "@unagents/messenger-client";
import type { InboundMessage, MessengerClient } from "@unagents/messenger-client";
import {
  MESSENGER_PROTOCOL,
  PROTOCOL_NAME,
  SERVER_VERSION_PATTERN,
  parseServerMessage,
  type ServerMessage,
} from "@agent-hand/bantou-protocol";
import { availableCpus, loadConfig } from "./config";
import { log, redactUrl } from "./log";
import { setBashWorkspace } from "./bash";
import { type McpListener } from "./mcp";
import { buildServerName, readMachineId } from "./name";
import { isValidWorkerId, workerDir } from "./paths";
import { listLiveProcesses, matchesSession } from "./processes";
import { replyPrompt } from "./prompts";
import { createWorkQueue, type Job, type WorkQueue } from "./queue";
import { removeReadyFile, writeReadyFile } from "./ready";
import { cliRunner } from "./runner";
import { findWorkerBySession, readState } from "./state";
import { createWorkerJob, resumeInput, type WorkerDeps, type WorkerRunInput } from "./worker";

/** center へ返す protocol の message に付ける messenger の meta（bantou protocol の登録と同じ値）。 */
export const REPLY_META = { protocol: MESSENGER_PROTOCOL.protocol, version: MESSENGER_PROTOCOL.version };

/** 受信 message の meta の扱い。bantou = bantou protocol、legacy = meta 無し、other = 他 protocol。 */
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

/** 指示の概要（ログ用）。prompt・content は先頭 80 文字のみ。 */
export function describeMessage(msg: ServerMessage): string {
  switch (msg.order) {
    case "launch":
      return `parent-id=${msg["parent-id"]} model=${msg.model ?? "(指定なし)"} ws=${redactUrl(msg.ws)}${msg.schema !== undefined ? ` schema=${redactUrl(msg.schema.url)}` : ""} prompt=${ignoreText(msg.prompt).slice(0, 80)}`;
    case "stop":
      return `parent-id=${msg["parent-id"]}`;
    case "answer":
      return `session-id=${msg["session-id"]} content=${ignoreText(msg.content).slice(0, 80)}`;
    case "approve":
    case "reject":
      return `session-id=${msg["session-id"]}`;
    default:
      return "";
  }
}

/** worker の id（作業 dir の名前）。 */
export const newWorkerId = (): string => `w-${randomBytes(5).toString("hex")}`;

export interface DispatchDeps {
  workspace: string;
  /** server-info の答えの版（npm bantou の版）。 */
  serverVersion: string;
  queue: Pick<WorkQueue, "submit" | "stop">;
  /** worker の実行を Job にする（onSettled は Job が終わった・外された時に 1 回呼ぶ）。 */
  makeJob: (input: WorkerRunInput, kind: "launch" | "reply", onSettled: () => void) => Job;
  /** protocol の message（meta 付き）を、送ってきた名前へ返す。 */
  replyToSender: (to: string, text: string) => Promise<void>;
  log: (msg: string) => void;
}

export interface Dispatcher {
  /** center → server の 1 通を処理する。guard に通らない物（exec を含む）は無視する。 */
  handle(m: Pick<InboundMessage, "text" | "meta" | "from_id" | "from_name" | "mode">): Promise<void>;
}

/** center → server の message を処理する。server は断らない（空きが無ければ queue で待たせる）。 */
export function createDispatcher(d: DispatchDeps): Dispatcher {
  /** queue で待っている・動いている session（同じ session を二重に起こさない）。 */
  const activeSessions = new Set<string>();

  const handle: Dispatcher["handle"] = async (m) => {
    if (m.mode === "ping") return;
    const from = `${m.from_name}(${m.from_id})`;
    if (classifyMeta(m.meta) === "other") {
      d.log(`無視(他 protocol): from=${from} protocol=${String(m.meta?.protocol)}`);
      return;
    }
    const msg = parseServerMessage(m.text);
    if (!msg) {
      d.log(`無視: from=${from} text=${ignoreText(m.text)}`);
      return;
    }
    d.log(`指示受信: ${msg.callType}/${msg.order} from=${from} ${describeMessage(msg)}`.trimEnd());
    const sender = m.from_name || m.from_id;
    switch (msg.order) {
      case "launch": {
        const workerId = newWorkerId();
        const input: WorkerRunInput = {
          workerId,
          dir: workerDir(d.workspace, workerId),
          parentId: msg["parent-id"],
          ws: msg.ws,
          ...(msg.schema !== undefined ? { schema: msg.schema } : {}),
          ...(msg.model !== undefined ? { model: msg.model } : {}),
          mode: "new",
          sessionId: randomUUID(),
          prompt: msg.prompt,
        };
        d.queue.submit(d.makeJob(input, "launch", () => {}));
        return;
      }
      case "stop": {
        const r = d.queue.stop(msg["parent-id"]);
        d.log(`停止: parent-id=${msg["parent-id"]} running=${r.running} queued=${r.queued}`);
        return;
      }
      case "answer":
      case "approve":
      case "reject": {
        const sessionId = msg["session-id"];
        const found = await findWorkerBySession(d.workspace, sessionId);
        if (!found) {
          d.log(`無視(session-id の worker が無い): session-id=${sessionId}`);
          return;
        }
        if (activeSessions.has(sessionId)) {
          d.log(`無視(その session はすでに動いている・待っている): session-id=${sessionId}`);
          return;
        }
        const input = await resumeInput(found.dir, replyPrompt(msg.order, msg.order === "answer" ? msg.content : undefined));
        if (!input) {
          d.log(`無視(state が無い): session-id=${sessionId}`);
          return;
        }
        activeSessions.add(sessionId);
        d.queue.submit(d.makeJob(input, "reply", () => activeSessions.delete(sessionId)));
        return;
      }
      case "server-info": {
        if (!SERVER_VERSION_PATTERN.test(d.serverVersion)) {
          d.log(`server-info に答えられない（版が x.y.z でない）: ${d.serverVersion}`);
          return;
        }
        const body = { protocol: PROTOCOL_NAME, callType: "status", order: "server-info", version: d.serverVersion };
        try {
          await d.replyToSender(sender, JSON.stringify(body));
          d.log(`返信: to=${sender} server-info version=${d.serverVersion}`);
        } catch (e) {
          d.log(`返信失敗: to=${sender} ${e instanceof Error ? e.message : String(e)}`);
        }
        return;
      }
    }
  };
  return { handle };
}

/** 起動済みの daemon。stop は実行中の claude・peer・broker を止める（プロセス終了は呼び出し側）。 */
export interface Daemon {
  stop(): Promise<void>;
  /** process の終了コード。 */
  exitCode(): number;
  /** agent-messenger に登録した名前。 */
  name: string;
}

/** daemon が使う外部資源。/mcp の listener は Nitro の h3App が要るので plugin から渡す。 */
export interface DaemonDeps {
  /** bantou protocol 定義（protocol.json を含む dir）。空なら protocol 登録を行わず名前待受のみ。 */
  protocolDir?: string;
  startMcp: (opts: { port: number; bind: string }) => Promise<McpListener>;
  /** 自分の npm 版（server-info の答え）。未指定は "unknown"（答えない）。 */
  serverVersion?: string;
  /** 名前の prefix（起動 option --name-prefix）。config の namePrefix より優先する。 */
  namePrefix?: string;
  /** 機械の ID の読み方（テストで差し替える）。 */
  machineId?: () => string;
  /** CPU 数と 1 分の負荷平均（テストで差し替える）。 */
  cpus?: () => number;
  loadavg1?: () => number;
  /** claude の実行（テストで差し替える）。 */
  runner?: WorkerDeps["runner"];
  /** agent-messenger の client の作り方（テストで差し替える）。 */
  createClient?: typeof createMessengerClient;
}

/** 設定を読み込んで起動し、常駐物を返す。シグナルと exit は呼び出し側（plugin）が担う。 */
export async function startDaemon(configPath: string, deps: DaemonDeps): Promise<Daemon> {
  log("起動");
  const config = await loadConfig(configPath, deps.cpus?.());
  log(`設定読込: ${configPath} (workspace=${config.workspace})`);
  // 名前: 機械の ID が読めなければ起動しない
  const prefix = deps.namePrefix ?? config.namePrefix;
  const name = buildServerName((deps.machineId ?? readMachineId)(), prefix);
  log(`名前: ${name}`);
  await mkdir(join(config.workspace, "workers"), { recursive: true });
  // 前回の server が残した claude（detached）を、指示を受け付ける前に止める
  const reaped = await reapOrphans(config.workspace).catch((e: unknown) => {
    log(`孤児回収に失敗: ${e instanceof Error ? e.message : String(e)}`);
    return [] as string[];
  });
  log(`孤児回収: killed=${reaped.length}`);

  const { port: wantPort, bind, discovery, token } = config.broker;
  const broker = await startBroker({
    port: wantPort,
    bind,
    token,
    discovery: discovery === "on",
    stateFile: join(config.workspace, "broker.json"),
  });
  log(`broker 起動: port=${broker.port} bind=${bind} discovery=${discovery} token=${token ? "有" : "無"} id=${broker.id}`);
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
  const mcpUrl = `${brokerUrl(config.mcp.bind, mcp.port)}/mcp`;
  log(`mcp 起動: url=${mcpUrl} bind=${config.mcp.bind}`);

  const cpus = deps.cpus ?? availableCpus;
  const queue = createWorkQueue({ maxParallel: config.session.maxParallel, cpus, loadavg1: deps.loadavg1 ?? (() => loadavg()[0] ?? 0), log });
  log(`worker の同時実行の上限: ${config.session.maxParallel}（cpus=${cpus()}、負荷平均が cpus を超えている間は新しく起こさない）`);
  const serverVersion = deps.serverVersion ?? "unknown";
  let client!: MessengerClient;
  let protocolSet = false;
  let closing = false;

  const workerDeps: WorkerDeps = {
    config,
    runner: deps.runner ?? cliRunner,
    mcpUrl: () => mcpUrl,
    // server → cap は、ふつうの agent-messenger の message（meta.protocol を付けない）。宛先は parent-id の名前、delivery は push
    sendToCap: async (to, body) => {
      await client.send(to, JSON.stringify(body), "push");
    },
    log,
  };
  const dispatcher = createDispatcher({
    workspace: config.workspace,
    serverVersion,
    queue,
    makeJob: (input, kind, onSettled) => createWorkerJob(workerDeps, input, kind, onSettled),
    // center へは、送ってきた名前に返す（meta 付き）
    replyToSender: async (to, text) => {
      await client.send(to, text, "push", REPLY_META);
    },
    log,
  });

  // 実行中の指示。claude の実行は数分かかるので全体は直列にしない
  const inflight = new Set<Promise<void>>();
  try {
    // 接続先は agent-messenger の通常の解決（env → config → UDP 発見 → ローカル fallback）に任せる。
    // 同じ名前の登録で error が返ったら、別の名前にせず起動しない（connect / setProtocol の例外はそのまま起動失敗）
    client = (deps.createClient ?? createMessengerClient)({
      name,
      summary: `${hostname()} ${config.workspace}`,
      autoStartBroker: false,
      log: (m) => log(`messenger: ${m}`),
    });
    client.onMessage((m) => {
      if (closing) return;
      const p: Promise<void> = dispatcher
        .handle(m)
        .catch((e: unknown) => log(`エラー: ${e instanceof Error ? e.message : String(e)}`))
        .finally(() => inflight.delete(p));
      inflight.add(p);
    });
    await client.connect();
    log(`peer 登録: name=${name} id=${client.peer.id}`);
    if (deps.protocolDir) {
      const info = await client.setProtocol(deps.protocolDir);
      protocolSet = true;
      log(`protocol 登録: ${info.name}@${info.version} hash=${info.hash} dir=${deps.protocolDir}`);
    } else {
      log("protocol 未指定のため登録しない（名前待受のみ）");
    }
  } catch (e) {
    await client?.close().catch(() => {});
    await mcp.close().catch(() => {});
    await broker.close().catch(() => {});
    throw e;
  }
  setBashWorkspace(config.workspace);

  // 前回の server が残した claude を止めた cap へ failed を返す（止めたのは指示を受け付ける前）
  for (const parentId of reaped) {
    await workerDeps.sendToCap(parentId, { status: "failed", content: REAPED_CONTENT }).catch((e: unknown) =>
      log(`孤児回収の failed を返せない: to=${parentId} ${e instanceof Error ? e.message : String(e)}`),
    );
  }

  const stop = async (): Promise<void> => {
    if (closing) return;
    closing = true;
    try {
      setBashWorkspace(undefined);
      queue.close();
      await Promise.allSettled([...inflight]);
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
  log(`常駐開始: name=${name} version=${serverVersion}`);
  return { stop, exitCode: () => 0, name };
}

const REAPED_CONTENT = "server の再起動で worker を止めた（最後の出力は無い）";

/**
 * 起動時: workers/ の state.json の session で、まだ生きている claude -p を止める。
 * 戻り値は止めた worker の cap の名前（worker ごとに 1 つ）。
 */
export async function reapOrphans(workspace: string): Promise<string[]> {
  const procs = await listLiveProcesses();
  if (procs === null) return [];
  let names: string[];
  try {
    names = await readdir(join(workspace, "workers"));
  } catch {
    return [];
  }
  const killed: string[] = [];
  for (const name of names) {
    if (!isValidWorkerId(name)) continue;
    const st = await readState(workerDir(workspace, name)).catch(() => undefined);
    if (st === undefined) continue;
    const hit = procs.filter((p) => matchesSession(p.argv, st.session_id));
    if (hit.length === 0) continue;
    for (const p of hit) {
      try {
        process.kill(-p.pid, "SIGKILL");
      } catch {
        try {
          process.kill(p.pid, "SIGKILL");
        } catch {
          // すでに終わっている
        }
      }
    }
    killed.push(st.parent_id);
  }
  return killed;
}
