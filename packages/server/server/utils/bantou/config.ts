import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";

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

/** 自己更新の取得元。{version} を更新先の版に置き換えて npx の --package に渡す。 */
export const DEFAULT_UPDATE = {
  spec: "bantou@{version}",
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
  workerKeepMs: 1_800_000,
  exitResumeMax: 3,
  exitRecoverMs: 3_600_000,
  maxParallelTasks: 2,
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
  /** 終わった worker の dir を掃除するまでの待ち時間（ms）。0 は掃除しない。 */
  workerKeepMs: number;
  /** 1 つの task で、worker の異常終了を理由に cap を再開する上限回数。超えたら再開せず task の結果に error を載せる。0 は再開しない。 */
  exitResumeMax: number;
  /** server 起動時に、直近この時間（ms）に終わった未通知の worker を拾う。0 は拾わない。 */
  exitRecoverMs: number;
  /**
   * 1 つの cap で同時に動かす task の上限（1 以上）。超えた分は前の task が終わるまで待つ。1 は従来どおり 1 つずつ。
   * 同じ deliverables.branch の task は、上限に関わらず前の task が終わるまで待つ。
   */
  maxParallelTasks: number;
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
  /** worker 報告の受け口（MCP over HTTP、/mcp）。 */
  mcp: { port: number; bind: string };
  /** headless 実行（claude -p）の設定。 */
  session: SessionConfig;
  /** 自己更新の設定。 */
  update: { spec: string; maxWaitMs?: number };
  /** cap / worker に載せる追加の stdio MCP。name → 定義。 */
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

function parseUpdate(v: unknown, path: string): Config["update"] {
  if (v === undefined) return { ...DEFAULT_UPDATE };
  if (!isRecord(v)) throw new Error(`config の update はオブジェクト: ${path}`);
  const spec = v.spec ?? DEFAULT_UPDATE.spec;
  if (typeof spec !== "string" || !spec.includes("{version}") || spec.startsWith("-") || spec.includes("\0")) {
    throw new Error(`config の update.spec は {version} を含む文字列（- で始められない）: ${path}`);
  }
  const maxWaitMs = v.maxWaitMs;
  if (maxWaitMs !== undefined && (typeof maxWaitMs !== "number" || !Number.isInteger(maxWaitMs) || maxWaitMs <= 0)) {
    throw new Error(`config の update.maxWaitMs は正の整数: ${path}`);
  }
  return { spec, ...(maxWaitMs !== undefined ? { maxWaitMs } : {}) };
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
  const workerKeepMs = v.workerKeepMs ?? DEFAULT_SESSION.workerKeepMs;
  if (typeof workerKeepMs !== "number" || !Number.isInteger(workerKeepMs) || workerKeepMs < 0) {
    throw new Error(`config の session.workerKeepMs は 0 以上の整数（0 は掃除しない）: ${path}`);
  }
  const exitResumeMax = v.exitResumeMax ?? DEFAULT_SESSION.exitResumeMax;
  if (typeof exitResumeMax !== "number" || !Number.isInteger(exitResumeMax) || exitResumeMax < 0) {
    throw new Error(`config の session.exitResumeMax は 0 以上の整数（0 は再開しない）: ${path}`);
  }
  const exitRecoverMs = v.exitRecoverMs ?? DEFAULT_SESSION.exitRecoverMs;
  if (typeof exitRecoverMs !== "number" || !Number.isInteger(exitRecoverMs) || exitRecoverMs < 0) {
    throw new Error(`config の session.exitRecoverMs は 0 以上の整数（0 は拾わない）: ${path}`);
  }
  const maxParallelTasks = v.maxParallelTasks ?? DEFAULT_SESSION.maxParallelTasks;
  if (typeof maxParallelTasks !== "number" || !Number.isInteger(maxParallelTasks) || maxParallelTasks < 1) {
    throw new Error(`config の session.maxParallelTasks は 1 以上の整数: ${path}`);
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
    workerKeepMs,
    exitResumeMax,
    exitRecoverMs,
    maxParallelTasks,
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
  // workspace 省略時は config.json のある dir（root dir 1 つの構成）
  const rootMode = obj.workspace === undefined;
  const ws = rootMode ? dirname(resolve(path)) : obj.workspace;
  if (typeof ws !== "string" || ws.length === 0) {
    throw new Error(`config の workspace は文字列: ${path}`);
  }
  if (!isAbsolute(ws)) {
    throw new Error(`config の workspace は絶対パス: ${ws}`);
  }
  const session = parseSession(obj.session, path);
  // root 構成では claude の設定も root 配下に置く（明示指定があればそちら）
  if (rootMode && session.env.CLAUDE_CONFIG_DIR === undefined) {
    session.env.CLAUDE_CONFIG_DIR = join(ws, ".claude");
  }
  return {
    workspace: ws,
    broker: parseBroker(obj.broker, path),
    mcp: parseMcp(obj.mcp, path),
    session,
    update: parseUpdate(obj.update, path),
    extraMcp: parseExtraMcp(obj.extraMcp, path),
  };
}
