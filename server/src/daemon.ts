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
import { loadConfig, type Config } from "./config.js";
import { log } from "./log.js";
import { launchSession, listSessions } from "./session.js";
import { prepareWorkspace } from "./workspace.js";

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

/** 指示を実行して返信内容を作る。失敗は ErrorReply にする。 */
async function execute(cmd: ServerCommand, config: Config): Promise<ServerReply> {
  try {
    if (cmd.type === "launch_session") {
      const r = await launchSession({
        ...cmd,
        repos: join(config.workspace, "repos"),
        command: config.session.command,
      });
      log(`tmux 作成: ${r.name} cwd=${r.cwd}`);
      return { bantou: PROTOCOL_VERSION, type: "session_launched", ok: true, ...r };
    }
    const sessions = await listSessions();
    return { bantou: PROTOCOL_VERSION, type: "sessions", ok: true, sessions };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    log(`エラー: ${cmd.type}: ${message}`);
    return { bantou: PROTOCOL_VERSION, type: "error", ok: false, message, command: cmd.type };
  }
}

/** 起動して常駐する。SIGTERM / SIGINT で後始末して exit 0。 */
export async function runDaemon(configPath: string): Promise<void> {
  log("起動");
  const config = await loadConfig(configPath);
  log(`設定読込: ${configPath} (workspace=${config.workspace})`);
  const repos = await prepareWorkspace(config.workspace);
  log(`workspace 準備完了: ${repos}`);

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
  let chain: Promise<void> = Promise.resolve();
  let client!: MessengerClient;

  // 指示は 1 件ずつ直列に処理する
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
      log(`指示受信: type=${cmd.type} from=${from} ${maskUserinfo(JSON.stringify(cmd))}`);
      const reply = await execute(cmd, config);
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
      chain = chain.then(() => handle(m));
    });
    await client.connect();
    log(`peer 登録: name=${SERVER_NAME} id=${client.peer.id} broker=${url}`);
  } catch (e) {
    await broker.close().catch(() => {});
    throw e;
  }

  const shutdown = (signal: string): void => {
    if (closing) return;
    closing = true;
    log(`${signal} 受信、終了処理`);
    const hard = setTimeout(() => {
      log("終了処理タイムアウト");
      process.exit(0);
    }, 5000);
    void (async () => {
      try {
        // 実行中の指示は少し待つ
        await Promise.race([chain, new Promise((r) => setTimeout(r, 4000))]);
        await client.close();
        await broker.close();
        log("broker 停止");
      } catch (e) {
        log(`終了処理エラー: ${e instanceof Error ? e.message : String(e)}`);
      }
      clearTimeout(hard);
      log("終了");
      process.exit(0);
    })();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
  log("常駐開始");
}
