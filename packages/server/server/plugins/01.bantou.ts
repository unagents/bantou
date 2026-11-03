import { toNodeListener } from "h3";
import { defineNitroPlugin, useRuntimeConfig } from "nitropack/runtime";
import { startDaemon, type Daemon } from "../utils/bantou/daemon";
import { fatalLine, log } from "../utils/bantou/log";
import { startMcpListener } from "../utils/bantou/mcp";

/**
 * bantou-server の常駐本体。broker・peer 登録・指示の処理を 1 つの plugin で async 直列に起動する。
 * node-listener preset は listen しないので、/mcp 用の listener だけ daemon 経由で自前で立てる。
 * signal と exit はここで握る。
 */
export default defineNitroPlugin((nitro) => {
  const { configPath, protocolDir, serverVersion } = useRuntimeConfig().bantou;
  let daemon: Daemon | undefined;
  let stopping = false;

  const shutdown = (signal: string): void => {
    if (stopping) return;
    stopping = true;
    log(signal === "update" ? "更新のため終了処理" : `${signal} 受信、終了処理`);
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

  void startDaemon(configPath, {
    protocolDir,
    serverVersion: serverVersion || undefined,
    // 更新の再起動: 通常の終了処理を通して exit 0（supervisor が update.json を見て次の子を起動する）
    requestExit: (reason) => shutdown(reason),
    startMcp: (opts) => startMcpListener(toNodeListener(nitro.h3App), opts),
  })
    .then((d) => {
      daemon = d;
    })
    .catch((e: unknown) => {
      console.error(fatalLine(e instanceof Error ? e.message : String(e)));
      process.exit(1);
    });
});
