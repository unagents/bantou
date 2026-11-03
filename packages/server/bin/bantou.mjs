#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_CONFIG = join(homedir(), ".config", "bantou", "config.json");
const binDir = dirname(fileURLToPath(import.meta.url));
const selfBin = fileURLToPath(import.meta.url);

/** この package の npm 版（package.json は npm tarball に必ず入る）。 */
function packageVersion() {
  return JSON.parse(readFileSync(join(binDir, "..", "package.json"), "utf8")).version;
}

/** 引数を解釈する。不正な引数は null を返す。 */
function parseArgs(argv) {
  let config = DEFAULT_CONFIG;
  let serve = false;
  let supervise = false;
  let version = false;
  let handoffProtocol = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--config" && i + 1 < argv.length) {
      config = argv[++i];
    } else if (argv[i] === "--serve") {
      serve = true;
    } else if (argv[i] === "--supervise") {
      supervise = true;
    } else if (argv[i] === "--version") {
      version = true;
    } else if (argv[i] === "--handoff-protocol") {
      handoffProtocol = true;
    } else {
      return null;
    }
  }
  if (serve && supervise) return null;
  return { config, serve, supervise, version, handoffProtocol };
}

const args = parseArgs(process.argv.slice(2));
if (!args) {
  console.error("usage: bantou [--config <path>] | bantou --version");
  process.exit(2);
}

if (args.version) {
  console.log(packageVersion());
  process.exit(0);
}

if (args.handoffProtocol) {
  // 引き継ぎに対応した版が自分の対応版を返す（旧 supervisor が引き継ぎ前に確かめる。未対応の版はこの引数で exit 2）
  console.log("1");
  process.exit(0);
}

const configPath = resolve(args.config);

if (!args.serve && !args.supervise) {
  // 既定: launcher。起動時に全コードを読み込み、supervisor（--supervise）を起動して見張る。以後 supervisor が入れ替わっても残る
  const launcher = await import("./launcher.mjs");
  let code;
  try {
    code = await launcher.runLauncher({ configPath, selfBin });
  } catch (e) {
    console.error(`${new Date().toISOString()} bantou: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
  process.exit(code);
}

const supervisor = await import("./supervisor.mjs");

if (args.supervise) {
  // supervisor。常駐本体は子（--serve）で動かす。更新時は新版の supervisor に引き継ぐ
  let code;
  try {
    code = await supervisor.runSupervisor({ configPath, selfBin, version: packageVersion() });
  } catch (e) {
    console.error(`${new Date().toISOString()} bantou: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
  process.exit(code);
} else {
  // 子（常駐本体）。supervisor 経由でない手起動による二重起動を防ぐ
  try {
    supervisor.assertServeAllowed(supervisor.readWorkspace(configPath));
  } catch (e) {
    console.error(`${new Date().toISOString()} bantou: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
  // config の中身（token 等）は env に載せない。パスだけを Nitro の runtimeConfig へ渡す
  process.env.NUXT_BANTOU_CONFIG_PATH = configPath;
  // 常駐本体へ自分の npm 版を渡す（hello_result の server_version）
  process.env.NUXT_BANTOU_SERVER_VERSION = packageVersion();
  // npm package に同梱した protocol 定義（server/protocol/、scripts/copy-protocol.mjs が作る）
  process.env.NUXT_BANTOU_PROTOCOL_DIR = join(binDir, "..", "protocol");
  const entry = join(binDir, "..", ".output", "server", "index.mjs");
  await import(entry);
}
