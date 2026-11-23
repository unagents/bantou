#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { DEFAULT_CONFIG, parseArgs, USAGE, type CliArgs } from "./args.js";
import { runDaemon } from "./daemon.js";
import { fatalLine } from "./log.js";
// 静的 import にする（動的 import にしない）。daemon.ts / sessions.ts が静的に import している module を
// ここで動的 import すると、bun build --compile がその依存（zod）を遅延初期化に包み、MCP SDK の
// top-level が zod の初期化前に走って起動時に落ちる（0.1.54: TypeError: undefined is not a constructor）。
import { runMemoryCli } from "./memory-settings.js";
import { runCoordinatorMcp } from "./coordinator-mcp.js";
import { watchParent } from "./parent-watch.js";
import { dirname } from "node:path";

if (process.argv[2] === "status-line") {
  // claude の statusLine から呼ばれるサブコマンド（stdin の JSON を center に POST する）。daemon は読み込まない
  const { runStatusLine } = await import("./status-line.js");
  process.exit(await runStatusLine(process.argv.slice(3)));
}

if (process.argv[2] === "hook") {
  // claude の hooks から呼ばれるサブコマンド（stdin の JSON を center に POST する）。daemon は読み込まない
  const { runHook } = await import("./status-line.js");
  process.exit(await runHook(process.argv.slice(3)));
}

if (process.argv[2] === "memory") {
  // 外部記憶の設定（center の側だけで扱う。MCP からは変えられない）。daemon は読み込まない
  process.exit(
    runMemoryCli(process.argv.slice(3), DEFAULT_CONFIG, {
      readStdin: () => readFileSync(0, "utf8"),
      readFile: (p) => readFileSync(p, "utf8"),
      out: (l) => console.log(l),
      err: (l) => console.error(l),
    }),
  );
}

if (process.argv[2] === "coordinator-mcp") {
  // 統括の道具を出す独立した MCP の server（http）。center が子として起動する。daemon は読み込まない
  const r = await runCoordinatorMcp(process.argv.slice(3), dirname(DEFAULT_CONFIG), { out: (l) => console.log(l), err: (l) => console.error(l) });
  if (r !== "serving") process.exit(r);
  // 親の center が消えたら自分も止まる
  watchParent({ onOrphan: () => process.exit(0) });
  process.once("SIGTERM", () => process.exit(0));
  process.once("SIGINT", () => process.exit(0));
  await new Promise<never>(() => {});
}

if (process.argv[2] === "stand-in") {
  // スリープ中の session の身代わりの messenger peer（center が子として起動する。1 session = 1 process）。daemon は読み込まない
  const { runStandIn } = await import("./stand-in.js");
  const r = await runStandIn(process.argv.slice(3), { out: (l) => console.log(l), err: (l) => console.error(l) });
  if (r !== "serving") process.exit(r);
  watchParent({ onOrphan: () => process.exit(0) });
  await new Promise<never>(() => {});
}

if (process.argv[2] === "mcp") {
  // MCP の接続の設定・鍵・試す（center の側だけで扱う。MCP からは変えられない）。daemon は読み込まない
  const { runMcpCli } = await import("./mcp-cli.js");
  const { readFileSync } = await import("node:fs");
  const { DEFAULT_CONFIG } = await import("./args.js");
  process.exit(
    await runMcpCli(process.argv.slice(3), DEFAULT_CONFIG, {
      readStdin: () => readFileSync(0, "utf8"),
      readFile: (p) => readFileSync(p, "utf8"),
      out: (l) => console.log(l),
      err: (l) => console.error(l),
    }),
  );
}

let args: CliArgs;
try {
  args = parseArgs(process.argv.slice(2));
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  console.error(USAGE);
  process.exit(2);
}

runDaemon(args).catch(async (e: unknown) => {
  const { PortInUseError } = await import("./port-check.js");
  // port が設定から決まる起動（`--port` 無し。bantou-center の本番）が使用中で終わる時は、正常終了にする（launchd が再起動し続けない。設計書 #16・#32）
  if (e instanceof PortInUseError && args.port === undefined) {
    console.error(fatalLine(e.message));
    process.exit(0);
  }
  console.error(fatalLine(e instanceof Error ? e.message : String(e)));
  process.exit(1);
});
