#!/usr/bin/env node
import { homedir } from "node:os";
import { join } from "node:path";
import { runDaemon } from "./daemon.js";

const DEFAULT_CONFIG = join(homedir(), ".config", "bantou-server", "config.json");

/** 引数を解釈する。不正な引数は null を返す。 */
function parseArgs(argv: string[]): { config: string } | null {
  let config = DEFAULT_CONFIG;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--config" && i + 1 < argv.length) {
      config = argv[++i];
    } else {
      return null;
    }
  }
  return { config };
}

const args = parseArgs(process.argv.slice(2));
if (!args) {
  console.error("usage: bantou-server [--config <path>]");
  process.exit(2);
}

runDaemon(args.config).catch((e: unknown) => {
  console.error(`bantou-server: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
