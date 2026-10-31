import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CliArgs } from "./args.js";
import { resolveClaude } from "./claude-path.js";
import { createActivityStore } from "./activity.js";
import { loadConfig, MIN_TOKEN_LEN } from "./config.js";
import { SESSION_MCP_PATH, startHttpServer, type HttpHandle } from "./http.js";
import { mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { log, setLogFile } from "./log.js";
import { watchParent } from "./parent-watch.js";
import { createFollow } from "./follow.js";
import { resolvePair } from "./pair.js";
import { createRemoteManager } from "./remotes.js";
import { createRemoteControlSupervisor } from "./remote-control.js";
import { createSessionManager } from "./sessions.js";
import { createJsonListStore } from "./store.js";
import { createCenterServer, createSessionMcpServer } from "./server.js";
import { createCore } from "./core.js";
import { createSessionTokens } from "./session-auth.js";
import { createServerLink } from "./server-link.js";

/** 強制終了の猶予に足す余裕（stop は SIGTERM 待ち stopGraceMs の後、SIGKILL 待ちで最大 5 秒）。 */
const HARD_EXIT_MARGIN_MS = 5_000;

/**
 * 起動して常駐する。SIGTERM / SIGINT で後始末して exit 0。
 * stdio では stdin EOF / 切断でも終了する。http では stdin を見ず（親が /dev/null を渡しても落ちない）、親プロセスの死亡で終了する。
 */
export async function runDaemon(args: CliArgs): Promise<void> {
  const configPath = args.config;
  log("起動");
  const config = await loadConfig(configPath);
  log(
    `設定読込: ${configPath} (projects=${config.projects.length} servers=${config.servers.length} logDir=${config.logDir})`,
  );
  if (config.projects.length === 0) {
    log(`remote-control は起動しない: projects が 0 件 (${configPath})`);
  } else if (!config.projects.some((p) => p.autostart)) {
    log(`remote-control は自動起動しない: autostart の project が 0 件 (projects=${config.projects.length}, ${configPath})`);
  }
  try {
    await mkdir(config.logDir, { recursive: true });
    setLogFile(join(config.logDir, "center.log"));
  } catch (e) {
    log(`center.log を開けない（stderr のみ）: ${e instanceof Error ? e.message : String(e)}`);
  }
  const claude = await resolveClaude(config.remoteControl.claude, log);
  const core = createCore();
  const sessionTokens = createSessionTokens();
  let httpPort: number | null = null;
  // session（master-cap）から center の MCP へ戻る URL。http で待ち受けていなければ null（--mcp-config を付けない）
  const sessionMcpUrl = (): string | null => {
    if (httpPort === null) return null;
    const b = args.bind;
    const host = b === "" || b === "0.0.0.0" || b === "::" || b === "localhost" ? "127.0.0.1" : b.includes(":") && !b.startsWith("[") ? `[${b}]` : b;
    return `http://${host}:${httpPort}${SESSION_MCP_PATH}`;
  };
  const supervisor = createRemoteControlSupervisor({
    config,
    log,
    claude,
    wrapper: { core, tokens: sessionTokens, mcpUrl: sessionMcpUrl },
  });
  const activity = createActivityStore();
  // 通知は 5 秒ごとに来るので、状態の組が変わった時だけログに出す
  const lastStates = new Map<string, string>();
  const link = createServerLink({
    config,
    log,
    onNotice: (n) => {
      activity.apply(n);
      const states = n.agents.map((a) => `${a.id}=${a.state}`).join(" ");
      if (lastStates.get(n.cap_id) !== states) {
        lastStates.set(n.cap_id, states);
        log(`activity 受信: cap_id=${n.cap_id} ${states}`);
      }
    },
  });
  // desktop のビルドと組になる版。違う server には更新を指示し、版が揃うまで指示を送らない
  const pair = resolvePair({ warn: log });
  log(`組の版: server=${pair.server ?? "(不明、版合わせは無効)"} protocol=${pair.protocol}`);
  const follow = createFollow({ link, pair, log });
  link.setGate((peer, command) => follow.gate(peer, command));
  // session / remote の保存先は config と同じ dir（config の projects には書かない）
  const stateDir = dirname(resolve(configPath));
  const sessions = createSessionManager({
    config,
    supervisor,
    store: createJsonListStore(join(stateDir, "sessions.json"), log),
    log,
  });
  const remotes = createRemoteManager({ link, store: createJsonListStore(join(stateDir, "remotes.json"), log), log, activity });

  let closing = false;
  let http: HttpHandle | null = null;
  const shutdown = async (reason: string): Promise<void> => {
    if (closing) return;
    closing = true;
    log(`終了開始: ${reason}`);
    const hard = setTimeout(() => {
      log("終了処理が間に合わず強制終了");
      supervisor.killAllSync("SIGKILL");
      process.exit(1);
    }, config.remoteControl.stopGraceMs + HARD_EXIT_MARGIN_MS);
    hard.unref();
    try {
      // 子の停止を最優先にする（http.close が長引いても子に signal が届くように）
      follow.stop();
      const results = await Promise.allSettled([supervisor.shutdown(), http?.close(), link.close()]);
      for (const r of results) {
        if (r.status === "rejected") throw r.reason;
      }
    } catch (e) {
      log(`終了処理エラー: ${e instanceof Error ? e.message : String(e)}`);
    }
    log("終了");
    process.exit(0);
  };
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGHUP", () => void shutdown("SIGHUP"));
  // 例外で落ちる場合も子を残さない
  process.on("uncaughtException", (e) => {
    log(`uncaughtException: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
    void shutdown("uncaughtException");
  });
  process.on("unhandledRejection", (e) => {
    log(`unhandledRejection: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
    void shutdown("unhandledRejection");
  });
  // どの経路で exit しても、残っている子には SIGKILL を送る（最後の砦。SIGKILL された時は走らない）
  process.on("exit", () => supervisor.killAllSync("SIGKILL"));
  // 読み手の消えた pipe への書込（EPIPE）で落ちない
  process.stderr.on("error", () => {});
  process.stdout.on("error", () => {});

  const makeServer = () => createCenterServer({ config, supervisor, link, sessions, remotes, follow });
  if (args.transport === "http") {
    if (!config.token || config.token.length < MIN_TOKEN_LEN) {
      throw new Error(`http transport には config の token（${MIN_TOKEN_LEN} 文字以上）が必要: ${configPath}`);
    }
    http = await startHttpServer({
      createServer: makeServer,
      createSessionServer: (owner) => createSessionMcpServer({ remotes, owner }),
      sessionAuth: sessionTokens,
      core,
      port: args.port,
      bind: args.bind,
      token: config.token,
      log,
    });
    httpPort = http.port;
    watchParent({ onOrphan: (reason) => void shutdown(reason) });
  } else {
    const server = makeServer();
    const transport = new StdioServerTransport();
    transport.onclose = () => void shutdown("MCP stdio 切断");
    // SDK の stdio transport は stdin の EOF を検知しないので自前で見る
    process.stdin.once("end", () => void shutdown("stdin EOF"));
    await server.connect(transport);
    log("MCP stdio 接続");
  }

  // transport を先に繋いでから、接続と autostart をバックグラウンドで進める
  void link.connectAll().finally(() => follow.start());
  void remotes.restore().catch((e: unknown) => log(`remote 記録の復元失敗: ${e instanceof Error ? e.message : String(e)}`));
  void sessions.restore().catch((e: unknown) => log(`session の復帰失敗: ${e instanceof Error ? e.message : String(e)}`));
  for (const p of config.projects) {
    if (!p.autostart) continue;
    supervisor.start(p.name).catch((e: unknown) => {
      log(`autostart 失敗: project=${p.name} ${e instanceof Error ? e.message : String(e)}`);
    });
  }
}
