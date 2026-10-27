import { homedir } from "node:os";
import { join } from "node:path";

export const DEFAULT_CONFIG = join(homedir(), ".config", "bantou", "center.json");
export const DEFAULT_PORT = 7910;
export const DEFAULT_BIND = "127.0.0.1";

export interface CliArgs {
  config: string;
  transport: "stdio" | "http";
  port: number;
  bind: string;
}

export const USAGE =
  "usage: bantou-center [--config <path>] [--transport stdio|http] [--port <n>] [--bind <addr>]";

/** 引数を解釈する。不正な引数・値は Error を投げる。`--port` / `--bind` は stdio では無視する。 */
export function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = { config: DEFAULT_CONFIG, transport: "stdio", port: DEFAULT_PORT, bind: DEFAULT_BIND };
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (key !== "--config" && key !== "--transport" && key !== "--port" && key !== "--bind") {
      throw new Error(`不明な引数: ${key}`);
    }
    if (i + 1 >= argv.length) throw new Error(`${key} に値が無い`);
    const value = argv[++i];
    if (key === "--config") {
      out.config = value;
    } else if (key === "--transport") {
      if (value !== "stdio" && value !== "http") throw new Error(`--transport は stdio / http のみ: ${value}`);
      out.transport = value;
    } else if (key === "--port") {
      // 0 は OS 任せ（実ポートはログに出る）
      if (!/^\d+$/.test(value) || Number(value) > 65535) throw new Error(`--port は 0〜65535 の整数: ${value}`);
      out.port = Number(value);
    } else if (value === "") {
      throw new Error("--bind が空");
    } else {
      out.bind = value;
    }
  }
  return out;
}
