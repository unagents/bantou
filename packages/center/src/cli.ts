#!/usr/bin/env node
import { parseArgs, USAGE, type CliArgs } from "./args.js";
import { runDaemon } from "./daemon.js";
import { fatalLine } from "./log.js";

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
