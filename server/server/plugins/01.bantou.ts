import { defineNitroPlugin, useRuntimeConfig } from "nitropack/runtime";
import { startDaemon, type Daemon } from "../utils/bantou/daemon";
import { fatalLine, log } from "../utils/bantou/log";

/**
 * bantou-server の常駐本体。broker・peer 登録・指示の処理を 1 つの plugin で async 直列に起動する。
 * node-listener preset のため listen はしない。signal と exit はここで握る。
 */
export default defineNitroPlugin((nitro) => {
  const configPath = useRuntimeConfig().bantou.configPath;
  let daemon: Daemon | undefined;
  let stopping = false;

  const shutdown = (signal: string): void => {
    if (stopping) return;
    stopping = true;
    log(`${signal} 受信、終了処理`);
    const hard = setTimeout(() => {
      log("終了処理タイムアウト");
      process.exit(0);
    }, 5000);
    void (async () => {
      try {
        await daemon?.stop();
        await nitro.hooks.callHook("close");
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

  void startDaemon(configPath)
    .then((d) => {
      daemon = d;
    })
    .catch((e: unknown) => {
      console.error(fatalLine(e instanceof Error ? e.message : String(e)));
      process.exit(1);
    });
});
