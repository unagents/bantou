import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";

export const DEFAULT_BROKER = {
  port: 7901,
  bind: "127.0.0.1",
  discovery: "on",
  token: "",
} as const;

/** worker 報告の受け口（MCP）。既定は固定 port（worker は cap より長く生きるため、再起動で変わらない値にする）。 */
export const DEFAULT_MCP = {
  port: 7902,
  bind: "127.0.0.1",
} as const;

/** `claude --permission-mode` の選択肢。 */
export const PERMISSION_MODES = [
  "acceptEdits",
  "auto",
  "bypassPermissions",
  "manual",
  "dontAsk",
  "plan",
] as const;

export const DEFAULT_SESSION = {
  claude: "claude",
  permissionMode: "auto",
  timeoutMs: 1_800_000,
  maxRetries: 1,
  allowedTools: [] as string[],
  disallowedTools: [] as string[],
  extraArgs: [] as string[],
  capBashSandbox: false,
  env: {} as Record<string, string>,
};

export interface SessionConfig {
  /** claude 実行ファイル。 */
  claude: string;
  /** `--permission-mode` に渡す値。 */
  permissionMode: string;
  /** 1 回の実行の打ち切り時間（ms）。 */
  timeoutMs: number;
  /** タイムアウト・起動失敗時の再試行回数。 */
  maxRetries: number;
  /** 空でなければ `--allowedTools`。 */
  allowedTools: string[];
  /** 空でなければ `--disallowedTools`。 */
  disallowedTools: string[];
  /** `--` の前にそのまま付ける追加引数。 */
  extraArgs: string[];
  /** true なら cap の Bash sandbox を claude の設定のまま（有効なら worker が cap と共に死ぬ）。false（既定）は `--settings {"sandbox":{"enabled":false}}` を付けて切る。 */
  capBashSandbox: boolean;
  /** spawn する claude に追加で渡す環境変数。自身の環境変数に上書きで合成する。 */
  env: Record<string, string>;
}

export interface Config {
  /** workspace フォルダの絶対パス。 */
  workspace: string;
  /** 内蔵 messenger broker の設定。 */
  broker: { port: number; bind: string; discovery: "on" | "off"; token: string };
  /** worker 報告の受け口（MCP over HTTP、/mcp）。 */
  mcp: { port: number; bind: string };
  /** headless 実行（claude -p）の設定。 */
  session: SessionConfig;
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

function parseMcp(v: unknown, path: string): Config["mcp"] {
  if (v === undefined) return { ...DEFAULT_MCP };
  if (!isRecord(v)) throw new Error(`config の mcp はオブジェクト: ${path}`);
  const port = v.port ?? DEFAULT_MCP.port;
  if (typeof port !== "number" || !Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`config の mcp.port は 0..65535 の整数: ${path}`);
  }
  const bind = v.bind ?? DEFAULT_MCP.bind;
  if (typeof bind !== "string" || bind.length === 0) {
    throw new Error(`config の mcp.bind は空でない文字列: ${path}`);
  }
  return { port, bind };
}

function parseStringList(v: unknown, key: string, path: string): string[] {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) {
    throw new Error(`config の session.${key} は文字列の配列: ${path}`);
  }
  return [...(v as string[])];
}

function parseEnv(v: unknown, path: string): Record<string, string> {
  if (v === undefined) return {};
  if (!isRecord(v) || Object.entries(v).some(([k, x]) => k.length === 0 || typeof x !== "string")) {
    throw new Error(`config の session.env は文字列値のオブジェクト: ${path}`);
  }
  return { ...(v as Record<string, string>) };
}

function parseSession(v: unknown, path: string): SessionConfig {
  if (v === undefined) return structuredClone(DEFAULT_SESSION);
  if (!isRecord(v)) throw new Error(`config の session はオブジェクト: ${path}`);
  if ("command" in v) {
    throw new Error("config の session.command は廃止。session.claude を使う");
  }
  const claude = v.claude ?? DEFAULT_SESSION.claude;
  if (typeof claude !== "string" || claude.length === 0) {
    throw new Error(`config の session.claude は空でない文字列: ${path}`);
  }
  const permissionMode = v.permissionMode ?? DEFAULT_SESSION.permissionMode;
  if (typeof permissionMode !== "string" || !(PERMISSION_MODES as readonly string[]).includes(permissionMode)) {
    throw new Error(`config の session.permissionMode は ${PERMISSION_MODES.join(" / ")} のいずれか: ${path}`);
  }
  const timeoutMs = v.timeoutMs ?? DEFAULT_SESSION.timeoutMs;
  if (typeof timeoutMs !== "number" || !Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error(`config の session.timeoutMs は正の整数: ${path}`);
  }
  const maxRetries = v.maxRetries ?? DEFAULT_SESSION.maxRetries;
  if (typeof maxRetries !== "number" || !Number.isInteger(maxRetries) || maxRetries < 0) {
    throw new Error(`config の session.maxRetries は 0 以上の整数: ${path}`);
  }
  const capBashSandbox = v.capBashSandbox ?? DEFAULT_SESSION.capBashSandbox;
  if (typeof capBashSandbox !== "boolean") {
    throw new Error(`config の session.capBashSandbox は真偽値: ${path}`);
  }
  return {
    claude,
    permissionMode,
    timeoutMs,
    maxRetries,
    allowedTools: parseStringList(v.allowedTools, "allowedTools", path),
    disallowedTools: parseStringList(v.disallowedTools, "disallowedTools", path),
    extraArgs: parseStringList(v.extraArgs, "extraArgs", path),
    capBashSandbox,
    env: parseEnv(v.env, path),
  };
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
  if (!isAbsolute(ws)) {
    throw new Error(`config の workspace は絶対パス: ${ws}`);
  }
  return {
    workspace: ws,
    broker: parseBroker(obj.broker, path),
    mcp: parseMcp(obj.mcp, path),
    session: parseSession(obj.session, path),
  };
}
