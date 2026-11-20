#!/usr/bin/env node
import { parseArgs, USAGE, type CliArgs } from "./args.js";
import { runDaemon } from "./daemon.js";
import { fatalLine } from "./log.js";

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
  const { runMemoryCli } = await import("./memory-settings.js");
  const { readFileSync } = await import("node:fs");
  const { DEFAULT_CONFIG } = await import("./args.js");
  process.exit(
    runMemoryCli(process.argv.slice(3), DEFAULT_CONFIG, {
      readStdin: () => readFileSync(0, "utf8"),
      readFile: (p) => readFileSync(p, "utf8"),
      out: (l) => console.log(l),
      err: (l) => console.error(l),
    }),
  );
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

runDaemon(args).catch((e: unknown) => {
  console.error(fatalLine(e instanceof Error ? e.message : String(e)));
  process.exit(1);
});
