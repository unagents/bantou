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
