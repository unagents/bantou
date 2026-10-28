#!/usr/bin/env node
import { homedir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_CONFIG = join(homedir(), ".config", "bantou", "config.json");

/** 引数を解釈する。不正な引数は null を返す。 */
function parseArgs(argv) {
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
  console.error("usage: bantou [--config <path>]");
  process.exit(2);
}

// config の中身（token 等）は env に載せない。パスだけを Nitro の runtimeConfig へ渡す
process.env.NUXT_BANTOU_CONFIG_PATH = resolve(args.config);
const entry = join(dirname(fileURLToPath(import.meta.url)), "..", ".output", "server", "index.mjs");
await import(entry);
