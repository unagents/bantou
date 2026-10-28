import { hostname } from "node:os";
import { join } from "node:path";
import { startBroker } from "@unagents/messenger-broker";
import { createBrokerClient, createMessengerClient } from "@unagents/messenger-client";
import type { InboundMessage, MessengerClient } from "@unagents/messenger-client";
import {
  PROTOCOL_VERSION,
  SERVER_NAME,
  parseServerCommand,
  type ServerCommand,
  type ServerReply,
} from "@agent-hand/bantou-protocol";
import { createAgentManager, type AgentManager } from "./agents";
import { loadConfig } from "./config";
import { log } from "./log";
import { cliRunner } from "./runner";
import { prepareWorkspace } from "./workspace";

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
    if (cmd.type === "resume_worker") {
      // server は worker を起動しない（worker は cap の責務）。型は protocol に残るが処理しない
      throw new Error("resume_worker は未対応");
    }
    const st = await manager.status();
    return { bantou: PROTOCOL_VERSION, type: "status_result", ok: true, ...st };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    log(`エラー: ${cmd.type}: ${message}`);
    const id = cmd.type === "kick_cap" ? { cap_id: cmd.cap_id } : {};
    return { bantou: PROTOCOL_VERSION, type: "error", ok: false, message, command: cmd.type, ...id };
  }
}

/** 起動済みの daemon。stop は実行中の claude・peer・broker を止める（プロセス終了は呼び出し側）。 */
export interface Daemon {
  stop(): Promise<void>;
}

/** 設定を読み込んで起動し、常駐物を返す。シグナルと exit は呼び出し側（plugin）が担う。 */
export async function startDaemon(configPath: string): Promise<Daemon> {
  log("起動");
  const config = await loadConfig(configPath);
  log(`設定読込: ${configPath} (workspace=${config.workspace})`);
  const dirs = await prepareWorkspace(config.workspace);
  log(`workspace 準備完了: caps=${dirs.caps} workers=${dirs.workers}`);
  const manager = createAgentManager({ config, runner: cliRunner, log });
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
  const url = brokerUrl(bind, broker.port);
  if (!["127.0.0.1", "::1", "localhost"].includes(bind) && token === "") {
    log(`警告: token 無しで ${bind} に bind。LAN から誰でも指示を送れる`);
  }

  let closing = false;
  let client!: MessengerClient;
  // 実行中の指示。claude の実行は数分かかるので全体は直列にしない。
  // 同一 agent の直列化は manager の queue が担い、別 agent は並行して走る
  const inflight = new Set<Promise<void>>();

  const handle = async (m: InboundMessage): Promise<void> => {
    try {
      if (m.mode === "ping") return;
      const from = `${m.from_name}(${m.from_id})`;
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
      const reply = await execute(cmd, manager);
      try {
        await client.send(m.from_id, JSON.stringify(reply));
        log(`返信: to=${m.from_id} type=${reply.type}`);
      } catch (e) {
        log(`返信失敗: to=${m.from_id} ${e instanceof Error ? e.message : String(e)}`);
      }
    } catch (e) {
      log(`エラー: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  try {
    // 前回異常終了で残った自分の peer を解除する
    const admin = createBrokerClient(token);
    admin.setUrl(url);
    const peers = await admin.post("/list-peers", {});
    for (const p of peers) {
      if (p.name === SERVER_NAME && p.hostname === hostname()) {
        await admin.post("/unregister", { id: p.id });
        log(`古い peer を解除: ${p.id}`);
      }
    }

    client = createMessengerClient({
      env: { AGENT_MESSENGER_DISCOVERY: "off", AGENT_MESSENGER_TOKEN: token },
      name: SERVER_NAME,
      summary: `${hostname()} ${config.workspace}`,
      brokers: [url],
      autoStartBroker: false,
      log: (m) => log(`messenger: ${m}`),
    });
    client.onMessage((m) => {
      const p: Promise<void> = handle(m).finally(() => inflight.delete(p));
      inflight.add(p);
    });
    await client.connect();
    log(`peer 登録: name=${SERVER_NAME} id=${client.peer.id} broker=${url}`);
  } catch (e) {
    await broker.close().catch(() => {});
    throw e;
  }

  const stop = async (): Promise<void> => {
    if (closing) return;
    closing = true;
    try {
      // 実行中の claude を止め、中断の返信を出し切るのを少し待つ
      await manager.shutdown();
      await Promise.race([
        Promise.allSettled([...inflight]),
        new Promise((r) => setTimeout(r, 2500)),
      ]);
      await client.close();
      await broker.close();
      log("broker 停止");
    } catch (e) {
      log(`終了処理エラー: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
  log("常駐開始");
  return { stop };
}
