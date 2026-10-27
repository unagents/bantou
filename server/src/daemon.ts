import { loadConfig } from "./config.js";
import { prepareWorkspace } from "./workspace.js";

const log = (msg: string): void => {
  console.log(`${new Date().toISOString()} bantou: ${msg}`);
};

/** 起動して常駐する。SIGTERM / SIGINT で後始末して exit 0。 */
export async function runDaemon(configPath: string): Promise<void> {
  log("起動");
  const config = await loadConfig(configPath);
  log(`設定読込: ${configPath} (workspace=${config.workspace})`);
  const repos = await prepareWorkspace(config.workspace);
  log(`workspace 準備完了: ${repos}`);

  const keepAlive = setInterval(() => {}, 1 << 30);
  const shutdown = (signal: string): void => {
    log(`${signal} 受信、終了処理`);
    clearInterval(keepAlive);
    log("終了");
    process.exit(0);
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
  log("常駐開始");
}
