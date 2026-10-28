import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CliArgs } from "./args.js";
import { resolveClaude } from "./claude-path.js";
import { loadConfig } from "./config.js";
import { startHttpServer, type HttpHandle } from "./http.js";
import { log } from "./log.js";
import { watchParent } from "./parent-watch.js";
import { createRemoteControlSupervisor } from "./remote-control.js";
import { createCenterServer } from "./server.js";
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
  const claude = await resolveClaude(config.remoteControl.claude, log);
  const supervisor = createRemoteControlSupervisor({ config, log, claude });
  const link = createServerLink({ config, log });

  let closing = false;
  let http: HttpHandle | null = null;
  const shutdown = async (reason: string): Promise<void> => {
    if (closing) return;
    closing = true;
    log(`終了開始: ${reason}`);
    const hard = setTimeout(() => {
      log("終了処理が間に合わず強制終了");
      process.exit(1);
    }, config.remoteControl.stopGraceMs + HARD_EXIT_MARGIN_MS);
    hard.unref();
    try {
      await http?.close();
      await supervisor.shutdown();
      await link.close();
    } catch (e) {
      log(`終了処理エラー: ${e instanceof Error ? e.message : String(e)}`);
    }
    log("終了");
    process.exit(0);
  };
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  process.once("SIGINT", () => void shutdown("SIGINT"));

  const makeServer = () => createCenterServer({ config, supervisor, link });
  if (args.transport === "http") {
    http = await startHttpServer({ createServer: makeServer, port: args.port, bind: args.bind, log });
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
  void link.connectAll();
  for (const p of config.projects) {
    if (!p.autostart) continue;
    supervisor.start(p.name).catch((e: unknown) => {
      log(`autostart 失敗: project=${p.name} ${e instanceof Error ? e.message : String(e)}`);
    });
  }
}
