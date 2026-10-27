import { readFile } from "node:fs/promises";

export const DEFAULT_SESSION_COMMAND = "claude --permission-mode auto";

export const DEFAULT_BROKER = {
  port: 7901,
  bind: "0.0.0.0",
  discovery: "on",
  token: "",
} as const;

export interface Config {
  /** workspace フォルダの絶対パス。 */
  workspace: string;
  /** 内蔵 messenger broker の設定。 */
  broker: { port: number; bind: string; discovery: "on" | "off"; token: string };
  /** tmux に起動する session の設定。 */
  session: { command: string };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function parseBroker(v: unknown, path: string): Config["broker"] {
  if (v === undefined) return { ...DEFAULT_BROKER };
  if (!isRecord(v)) throw new Error(`config の broker はオブジェクト: ${path}`);
  const port = v.port ?? DEFAULT_BROKER.port;
  if (typeof port !== "number" || !Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`config の broker.port は 0..65535 の整数: ${path}`);
  }
  const bind = v.bind ?? DEFAULT_BROKER.bind;
  if (typeof bind !== "string" || bind.length === 0) {
    throw new Error(`config の broker.bind は空でない文字列: ${path}`);
  }
  const discovery = v.discovery ?? DEFAULT_BROKER.discovery;
  if (discovery !== "on" && discovery !== "off") {
    throw new Error(`config の broker.discovery は "on" か "off": ${path}`);
  }
  const token = v.token ?? DEFAULT_BROKER.token;
  if (typeof token !== "string") {
    throw new Error(`config の broker.token は文字列: ${path}`);
  }
  return { port, bind, discovery, token };
}

function parseSession(v: unknown, path: string): Config["session"] {
  if (v === undefined) return { command: DEFAULT_SESSION_COMMAND };
  if (!isRecord(v)) throw new Error(`config の session はオブジェクト: ${path}`);
  const command = v.command ?? DEFAULT_SESSION_COMMAND;
  if (typeof command !== "string" || command.length === 0) {
    throw new Error(`config の session.command は空でない文字列: ${path}`);
  }
  return { command };
}

/** config.json を読み込んで検証する。 */
export async function loadConfig(path: string): Promise<Config> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (e) {
    throw new Error(`config を読めない: ${path} (${(e as Error).message})`);
  }
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    throw new Error(`config が JSON として不正: ${path} (${(e as Error).message})`);
  }
  const obj = isRecord(data) ? data : {};
  const ws = obj.workspace;
  if (typeof ws !== "string" || ws.length === 0) {
    throw new Error(`config の workspace は必須の文字列: ${path}`);
  }
  return {
    workspace: ws,
    broker: parseBroker(obj.broker, path),
    session: parseSession(obj.session, path),
  };
}
