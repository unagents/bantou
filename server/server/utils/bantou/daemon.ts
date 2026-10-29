import { mkdir, writeFile } from "node:fs/promises";
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
  type ServerReply,
} from "@agent-hand/bantou-protocol";
import { createActivityTracker } from "./activity";
import { createAgentManager, type AgentManager, type RunExtras } from "./agents";
import { loadConfig } from "./config";
import { log } from "./log";
import { CAP_ID_HEADER, WORKER_ID_HEADER, type McpListener } from "./mcp";
import { agentDir, runLogDir } from "./paths";
import { CAP_GUIDE, WORKER_GUIDE } from "./prompts";
import { createReportHub, setReportHandler } from "./reports";
import { cliRunner } from "./runner";
import { createWorkerHub, readOwner, setWorkerHandler, writeOwner } from "./workers";
import { prepareWorkspace } from "./workspace";

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

/** 指示の概要。prompt は先頭 80 文字のみ、repo の userinfo は伏せる。 */
export function describeCommand(cmd: ServerCommand): string {
  if (cmd.type === "stop_cap") return `cap_id=${cmd.cap_id}`;
  if (cmd.type !== "kick_cap") return "";
  const parts = [`cap_id=${cmd.cap_id}`];
  if (cmd.repo) parts.push(`repo=${maskUserinfo(cmd.repo)}`);
  if (cmd.branch) parts.push(`branch=${cmd.branch}`);
  if (cmd.reason) parts.push(`reason=${ignoreText(cmd.reason)}`);
  parts.push(`prompt=${ignoreText(cmd.prompt).slice(0, 80)}`);
  return parts.join(" ");
}

/** 指示を実行して返信内容を作る。失敗は ErrorReply にする。 */
export async function execute(cmd: ServerCommand, manager: AgentManager): Promise<ServerReply> {
  try {
    if (cmd.type === "kick_cap") {
      const r = await manager.invoke("cap", cmd.cap_id, cmd);
      return { bantou: PROTOCOL_VERSION, type: "cap_result", cap_id: cmd.cap_id, ...r };
    }
    if (cmd.type === "stop_cap") {
      const r = await manager.stop("cap", cmd.cap_id);
      return { bantou: PROTOCOL_VERSION, type: "stop_result", ok: true, cap_id: cmd.cap_id, stopped: r.stopped };
    }
    if (cmd.type === "resume_worker") {
      // worker は cap の依頼（/mcp の worker_start）で起動する。型は protocol に残るが center からの指示としては処理しない
      throw new Error("resume_worker は未対応");
    }
    const st = await manager.status();
    return { bantou: PROTOCOL_VERSION, type: "status_result", ok: true, ...st };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    log(`エラー: ${cmd.type}: ${message}`);
    const id = cmd.type === "kick_cap" || cmd.type === "stop_cap" ? { cap_id: cmd.cap_id } : {};
    return { bantou: PROTOCOL_VERSION, type: "error", ok: false, message, command: cmd.type, ...id };
  }
}

/** 起動済みの daemon。stop は実行中の claude・peer・broker を止める（プロセス終了は呼び出し側）。 */
export interface Daemon {
  stop(): Promise<void>;
}

/** daemon が使う外部資源。/mcp の listener は Nitro の h3App が要るので plugin から渡す。 */
export interface DaemonDeps {
  /** bantou protocol 定義（protocol.json を含む dir）。空なら protocol 登録を行わず名前待受のみ。 */
  protocolDir?: string;
  startMcp: (opts: { port: number; bind: string }) => Promise<McpListener>;
}

/** 設定を読み込んで起動し、常駐物を返す。シグナルと exit は呼び出し側（plugin）が担う。 */
export async function startDaemon(configPath: string, deps: DaemonDeps): Promise<Daemon> {
  log("起動");
  const config = await loadConfig(configPath);
  log(`設定読込: ${configPath} (workspace=${config.workspace})`);
  const dirs = await prepareWorkspace(config.workspace);
  log(`workspace 準備完了: caps=${dirs.caps} workers=${dirs.workers}`);
  // /mcp が立つ前は run が起きない（reapOrphans は run しない）。runExtras はその後の値を使う
  let mcpUrl: string | undefined;
  const tracker = createActivityTracker({
    notify: (capId, notice) => hub.notify(capId, notice),
    log,
  });
  const runExtras = async (kind: "cap" | "worker", id: string, input: { capId?: string }): Promise<RunExtras> => {
    if (!mcpUrl) throw new Error("mcp が未起動");
    const dir = agentDir(config.workspace, kind, id);
    const headers: Record<string, string> = {};
    if (kind === "cap") {
      headers[CAP_ID_HEADER] = id;
    } else {
      const capId = input.capId ?? (await readOwner(config.workspace, id));
      if (!capId) throw new Error(`worker の持ち主 cap が分からない: ${id}`);
      await writeOwner(config.workspace, id, capId);
      headers[CAP_ID_HEADER] = capId;
      headers[WORKER_ID_HEADER] = id;
    }
    // 引数に本文を直書きすると " -- " を含む時に孤児回収が照合できなくなるのでファイルで渡す（claude.ts）
    const logs = runLogDir(dir);
    await mkdir(logs, { recursive: true });
    const mcpConfigFile = join(logs, "mcp.json");
    const appendSystemPromptFile = join(logs, "system-prompt.md");
    await writeFile(mcpConfigFile, JSON.stringify({ mcpServers: { bantou: { type: "http", url: mcpUrl, headers } } }) + "\n");
    await writeFile(appendSystemPromptFile, (kind === "cap" ? CAP_GUIDE : WORKER_GUIDE) + "\n");
    return {
      mcpConfigFile,
      appendSystemPromptFile,
      extraAllowedTools:
        kind === "cap"
          ? ["mcp__bantou__worker_start", "mcp__bantou__worker_status", "mcp__bantou__worker_stop"]
          : ["mcp__bantou__report"],
    };
  };
  const manager = createAgentManager({ config, runner: cliRunner, log, observer: tracker, runExtras });
  const reaped = await manager.reapOrphans();
  log(`孤児回収: killed=${reaped.killed} failed=${reaped.failed} error=${reaped.errored}`);

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
  let client!: MessengerClient;
  let protocolSet = false;
  const hub = createReportHub({
    workspace: config.workspace,
    invoke: (capId, input) => manager.invoke("cap", capId, input),
    send: async (to, reply) => {
      await client.send(to, JSON.stringify(reply), "pull", REPLY_META);
    },
    log,
  });
  // 実行中の指示。claude の実行は数分かかるので全体は直列にしない。
  // 同一 agent の直列化は manager の queue が担い、別 agent は並行して走る
  const inflight = new Set<Promise<void>>();

  const handle = async (m: InboundMessage): Promise<void> => {
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
      log(`指示受信: type=${cmd.type} from=${from} ${describeCommand(cmd)}`.trimEnd());
      // 以降この cap の結果（report 起因の resume を含む）はこの center へ返す
      if (cmd.type === "kick_cap") await hub.rememberCenter(cmd.cap_id, m.from_id);
      const reply = await execute(cmd, manager);
      try {
        await client.send(m.from_id, JSON.stringify(reply), "pull", REPLY_META);
        log(`返信: to=${m.from_id} type=${reply.type} meta=${REPLY_META.protocol}@${REPLY_META.version}`);
      } catch (e) {
        log(`返信失敗: to=${m.from_id} ${e instanceof Error ? e.message : String(e)}`);
      }
    } catch (e) {
      log(`エラー: ${e instanceof Error ? e.message : String(e)}`);
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
    return hub.report(capId, workerId, kind, text);
  });
  setWorkerHandler(createWorkerHub({ workspace: config.workspace, manager, activity: tracker, log }));
  // 起動時に回収した running は lost として center へ知らせる
  for (const r of reaped.reaped) {
    const capId = r.kind === "cap" ? r.id : await readOwner(config.workspace, r.id);
    if (capId) tracker.seedLost(r.kind, r.id, capId, r.error);
  }

  const stop = async (): Promise<void> => {
    if (closing) return;
    closing = true;
    try {
      // 実行中の claude を止め、中断の返信を出し切るのを少し待つ
      setReportHandler(undefined);
      setWorkerHandler(undefined);
      hub.close();
      await manager.shutdown();
      await Promise.race([
        Promise.allSettled([...inflight, hub.drain()]),
        new Promise((r) => setTimeout(r, 2500)),
      ]);
      tracker.close();
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
  log("常駐開始");
  return { stop };
}
