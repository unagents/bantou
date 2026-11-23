import { readFile } from "node:fs/promises";
import { availableParallelism } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

export const DEFAULT_BROKER = {
  port: 7901,
  bind: "127.0.0.1",
  discovery: "on",
  token: "",
} as const;

/** worker の bash 道具の受け口（MCP）。既定は固定 port（worker は server の再起動をまたいで生きうるので、変わらない値にする）。 */
export const DEFAULT_MCP = {
  port: 7902,
  bind: "127.0.0.1",
} as const;

/** 名前の prefix（英小文字・数字 1〜16 文字）。 */
export const NAME_PREFIX_PATTERN = /^[a-z0-9]{1,16}$/;

/** `claude --permission-mode` の選択肢。 */
export const PERMISSION_MODES = [
  "acceptEdits",
  "auto",
  "bypassPermissions",
  "manual",
  "dontAsk",
  "plan",
] as const;

/** この host の CPU 数。 */
export const availableCpus = (): number => availableParallelism();

/** 同時に動かす worker の数の既定: CPU 数 − 1（最低 1）。 */
export function defaultMaxParallel(cpus: number): number {
  return Math.max(1, cpus - 1);
}

export const DEFAULT_SESSION = {
  claude: "claude",
  permissionMode: "auto",
  timeoutMs: 1_800_000,
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
  /** 空でなければ `--allowedTools`。 */
  allowedTools: string[];
  /** 空でなければ `--disallowedTools`。 */
  disallowedTools: string[];
  /** `--` の前にそのまま付ける追加引数。 */
  extraArgs: string[];
  /** true なら cap の Bash sandbox を claude の設定のまま（有効なら worker が cap と共に死ぬ）。false（既定）は `--settings {"sandbox":{"enabled":false}}` を付けて切る。 */
  capBashSandbox: boolean;
  /** 同時に動かす worker の数（reply の起こし直しも数える）。既定は CPU 数 − 1（最低 1）。 */
  maxParallel: number;
  /** spawn する claude に追加で渡す環境変数。自身の環境変数に上書きで合成する。 */
  env: Record<string, string>;
}

/** server が組む MCP の名前（追加の道具は同名にできない）。 */
export const RESERVED_MCP_NAMES = ["bantou"] as const;

export type ExtraMcpTarget = "cap" | "worker";

/** 追加の stdio MCP の道具（手元で動く物）。鍵を要する接続は扱わない。 */
export interface ExtraMcpServer {
  command: string;
  args: string[];
  env: Record<string, string>;
  /** 載せる側。省略は両方。 */
  targets: ExtraMcpTarget[];
}

export interface Config {
  /** workspace フォルダの絶対パス。 */
  workspace: string;
  /** 内蔵 messenger broker の設定。 */
  broker: { port: number; bind: string; discovery: "on" | "off"; token: string };
  /** worker の bash 道具の受け口（MCP over HTTP、/mcp）。 */
  mcp: { port: number; bind: string };
  /** headless 実行（claude -p）の設定。 */
  session: SessionConfig;
  /** agent-messenger に登録する名前の prefix。起動 option --name-prefix が優先。 */
  namePrefix?: string;
  /** worker に載せる追加の stdio MCP。name → 定義。 */
  extraMcp?: Record<string, ExtraMcpServer>;
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

/** namePrefix（config の項目と起動 option で同じ検証）。不正なら投げる。 */
export function assertNamePrefix(v: unknown, where: string): string {
  if (typeof v !== "string" || !NAME_PREFIX_PATTERN.test(v)) {
    throw new Error(`${where} は英小文字・数字 1〜16 文字: ${String(v)}`);
  }
  return v;
}

/** 名前の衝突判定用。- と _ を同一視し、大小を区別しない。 */
export function normalizeMcpName(name: string): string {
  return name.toLowerCase().replace(/-/g, "_");
}

const EXTRA_MCP_KEYS = ["command", "args", "env", "targets"];

function parseExtraMcp(v: unknown, path: string): Record<string, ExtraMcpServer> {
  if (v === undefined) return {};
  if (!isRecord(v)) throw new Error(`config の extraMcp はオブジェクト: ${path}`);
  const out: Record<string, ExtraMcpServer> = {};
  const seen = new Map<string, string>();
  for (const [name, def] of Object.entries(v)) {
    const where = `extraMcp.${name}`;
    if (!/^[A-Za-z0-9_-]+$/.test(name) || name.includes("__")) {
      throw new Error(`config の extraMcp の名前は英数字・_・- のみで "__" を含まない: ${name} (${path})`);
    }
    const norm = normalizeMcpName(name);
    if (RESERVED_MCP_NAMES.some((r) => normalizeMcpName(r) === norm)) {
      throw new Error(`config の extraMcp の名前 ${name} は server の MCP と衝突する（予約名。- と _ ・大小は同一視）: ${path}`);
    }
    const clash = seen.get(norm);
    if (clash !== undefined) {
      throw new Error(`config の extraMcp の名前 ${name} は ${clash} と衝突する（- と _ ・大小は同一視）: ${path}`);
    }
    seen.set(norm, name);
    if (!isRecord(def)) throw new Error(`config の ${where} はオブジェクト: ${path}`);
    for (const k of Object.keys(def)) {
      if (!EXTRA_MCP_KEYS.includes(k)) {
        throw new Error(`config の ${where} に未知のキー ${k}（command / args / env / targets のみ。stdio 専用）: ${path}`);
      }
    }
    const { command } = def;
    if (typeof command !== "string" || command.length === 0 || command.includes("\0")) {
      throw new Error(`config の ${where}.command は空でない文字列: ${path}`);
    }
    // 省略（undefined）だけが既定。null は不正として拒否する
    const args = def.args === undefined ? [] : def.args;
    if (!Array.isArray(args) || args.some((x) => typeof x !== "string" || x.includes("\0"))) {
      throw new Error(`config の ${where}.args は文字列の配列: ${path}`);
    }
    const env = def.env === undefined ? {} : def.env;
    if (
      !isRecord(env) ||
      Object.entries(env).some(([k, x]) => k.length === 0 || k.includes("=") || k.includes("\0") || typeof x !== "string" || x.includes("\0"))
    ) {
      throw new Error(`config の ${where}.env は文字列値のオブジェクト: ${path}`);
    }
    const targets = def.targets === undefined ? ["cap", "worker"] : def.targets;
    if (
      !Array.isArray(targets) ||
      targets.length === 0 ||
      targets.some((t) => t !== "cap" && t !== "worker") ||
      new Set(targets).size !== targets.length
    ) {
      throw new Error(`config の ${where}.targets は "cap" / "worker" の重複なし非空配列: ${path}`);
    }
    out[name] = {
      command,
      args: [...(args as string[])],
      env: { ...(env as Record<string, string>) },
      targets: [...(targets as ExtraMcpTarget[])],
    };
  }
  return out;
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

function parseSession(v: unknown, path: string, cpus: number): SessionConfig {
  if (v === undefined) return { ...structuredClone(DEFAULT_SESSION), maxParallel: defaultMaxParallel(cpus) };
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
  const capBashSandbox = v.capBashSandbox ?? DEFAULT_SESSION.capBashSandbox;
  if (typeof capBashSandbox !== "boolean") {
    throw new Error(`config の session.capBashSandbox は真偽値: ${path}`);
  }
  const maxParallel = v.maxParallel ?? defaultMaxParallel(cpus);
  if (typeof maxParallel !== "number" || !Number.isInteger(maxParallel) || maxParallel < 1) {
    throw new Error(`config の session.maxParallel は 1 以上の整数（省略 = CPU 数 − 1、最低 1）: ${path}`);
  }
  return {
    claude,
    permissionMode,
    timeoutMs,
    allowedTools: parseStringList(v.allowedTools, "allowedTools", path),
    disallowedTools: parseStringList(v.disallowedTools, "disallowedTools", path),
    extraArgs: parseStringList(v.extraArgs, "extraArgs", path),
    capBashSandbox,
    maxParallel,
    env: parseEnv(v.env, path),
  };
}

/** config.json を読み込んで検証する。cpus は maxParallel の既定の計算用（テストで差し替える）。 */
export async function loadConfig(path: string, cpus: number = availableCpus()): Promise<Config> {
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
  // workspace 省略時は config.json のある dir（root dir 1 つの構成）
  const rootMode = obj.workspace === undefined;
  const ws = rootMode ? dirname(resolve(path)) : obj.workspace;
  if (typeof ws !== "string" || ws.length === 0) {
    throw new Error(`config の workspace は文字列: ${path}`);
  }
  if (!isAbsolute(ws)) {
    throw new Error(`config の workspace は絶対パス: ${ws}`);
  }
  const session = parseSession(obj.session, path, cpus);
  const namePrefix = obj.namePrefix === undefined ? undefined : assertNamePrefix(obj.namePrefix, `config の namePrefix（${path}）`);
  // root 構成では claude の設定も root 配下に置く（明示指定があればそちら）
  if (rootMode && session.env.CLAUDE_CONFIG_DIR === undefined) {
    session.env.CLAUDE_CONFIG_DIR = join(ws, ".claude");
  }
  return {
    workspace: ws,
    broker: parseBroker(obj.broker, path),
    mcp: parseMcp(obj.mcp, path),
    session,
    ...(namePrefix !== undefined ? { namePrefix } : {}),
    extraMcp: parseExtraMcp(obj.extraMcp, path),
  };
}
