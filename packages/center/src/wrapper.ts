import { dirname, join } from "node:path";

/** wrapper（bantou-pty-wrapper）の場所。env BANTOU_PTY_WRAPPER で上書き、無ければ center の実行ファイルと同じ dir。 */
export function resolveWrapperPath(env: NodeJS.ProcessEnv = process.env, execPath = process.execPath): string {
  if (env.BANTOU_PTY_WRAPPER) return env.BANTOU_PTY_WRAPPER;
  return join(dirname(execPath), process.platform === "win32" ? "bantou-pty-wrapper.exe" : "bantou-pty-wrapper");
}

/** wrapper -> center の 1 行（stdout）。 */
export type WrapperMessage =
  | { t: "started"; pid: number | null }
  | { t: "output"; data: Buffer }
  | { t: "text"; data: string }
  | { t: "exit"; code: number | null; signal: string | null };

/** 1 行を解釈する。壊れた行・未知の t は null。 */
export function parseWrapperLine(line: string): WrapperMessage | null {
  let m: unknown;
  try {
    m = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof m !== "object" || m === null) return null;
  const o = m as Record<string, unknown>;
  switch (o.t) {
    case "started":
      return { t: "started", pid: typeof o.pid === "number" ? o.pid : null };
    case "output":
      return typeof o.data === "string" ? { t: "output", data: Buffer.from(o.data, "base64") } : null;
    case "text":
      return typeof o.data === "string" ? { t: "text", data: o.data } : null;
    case "exit":
      return {
        t: "exit",
        code: typeof o.code === "number" ? o.code : null,
        signal: typeof o.signal === "string" ? o.signal : null,
      };
    default:
      return null;
  }
}

/** center -> wrapper の 1 行（末尾の改行込み）。 */
export const encodeInput = (data: Buffer): string => `${JSON.stringify({ t: "input", data: data.toString("base64") })}\n`;
export const encodeResize = (cols: number, rows: number): string => `${JSON.stringify({ t: "resize", cols, rows })}\n`;
export const encodeStop = (): string => `${JSON.stringify({ t: "stop" })}\n`;

/** session に足す agent-messenger の MCP（plugin `messenger` の .mcp.json と同じ npx 起動）の版。 */
export const MESSENGER_VERSION = "0.12.2";

/** --mcp-config 内の agent-messenger の entry 名（user scope の `agent-messenger` と衝突させない別名）。 */
export const MESSENGER_SERVER_KEY = "bantou-messenger";

/** --mcp-config 内の外部記憶の entry 名（tool は mcp__memory__*）。 */
export const MEMORY_SERVER_KEY = "memory";

/** 外部記憶の token を claude の env に渡す変数名（--mcp-config の headers が ${…} で参照する）。 */
export const MEMORY_TOKEN_ENV = "BANTOU_MEMORY_TOKEN";

/**
 * --mcp-config に渡す JSON 文字列。
 * - messenger: session 名を peer 名（AGENT_MESSENGER_NAME）にした agent-messenger の stdio MCP。常に付ける。
 *   broker は client が自分で解決する（env → config → UDP 発見）ので指名しない。
 * - bantou: token は ${BANTOU_SESSION_TOKEN} のまま（claude が環境変数から展開する）。url が無い時は付けない。
 * - memory: 外部記憶の設定がある時だけ付ける（type: "http"）。X-Agent-Id は agentId、無ければ session 名。
 *   token がある時だけ Authorization: Bearer ${BANTOU_MEMORY_TOKEN}（実値はファイル・argv に書かず、env で渡す）。
 */
export function mcpConfigJson(url: string | null, session: string, memory?: { url: string; token?: string; agentId?: string }): string {
  const mcpServers: Record<string, unknown> = {
    [MESSENGER_SERVER_KEY]: {
      type: "stdio",
      command: "npx",
      args: ["-y", `@unagents/messenger@${MESSENGER_VERSION}`, "mcp"],
      env: { AGENT_MESSENGER_NAME: session, AGENT_MESSENGER_CLIENT_SPEC: MESSENGER_VERSION },
    },
  };
  if (url) {
    mcpServers[BANTOU_SERVER_KEY] = {
      type: "http",
      url,
      headers: { Authorization: "Bearer ${BANTOU_SESSION_TOKEN}", "X-Bantou-Session": session },
    };
  }
  if (memory) {
    mcpServers[MEMORY_SERVER_KEY] = {
      type: "http",
      url: memory.url,
      headers: {
        ...(memory.token ? { Authorization: "Bearer ${" + MEMORY_TOKEN_ENV + "}" } : {}),
        "X-Agent-Id": memory.agentId || session,
      },
    };
  }
  return JSON.stringify({ mcpServers });
}

/** --mcp-config 内の bantou 窓口の entry 名（tool は mcp__bantou__*）。 */
export const BANTOU_SERVER_KEY = "bantou";

/**
 * --settings の permissions.allow に入れる、bantou 自身の MCP tool の許可。書式は公式 docs（permissions の MCP 節）の
 * `mcp__<server>__*`（server の全 tool）。server 名は --mcp-config の entry 名と同じ。
 * - bantou-messenger: 常に付ける（mcpConfigJson が常に付ける）
 * - bantou: 窓口がある時だけ（mcpConfigJson が url 無しで付けない時は入れない）
 * - memory: 外部記憶がある時だけ
 */
export function bantouAllowRules(opts: { bantou: boolean; memory: boolean }): string[] {
  return [
    `mcp__${MESSENGER_SERVER_KEY}__*`,
    ...(opts.bantou ? [`mcp__${BANTOU_SERVER_KEY}__*`] : []),
    ...(opts.memory ? [`mcp__${MEMORY_SERVER_KEY}__*`] : []),
  ];
}

export const DEFAULT_COLS = 120;
export const DEFAULT_ROWS = 40;

/** wrapper の引数全体（wrapper 自身のオプション + `--` + claude とその引数）。 */
export function buildWrapperArgs(opts: {
  claudePath: string;
  name: string;
  permissionMode: string;
  mcpConfig: string | null;
  /** claude の --settings にそのまま渡す JSON 文字列（statusLine のみ）。無ければ付けない。 */
  settings?: string | null;
  resume: boolean;
  /** claude の --model にそのまま渡す。無ければ付けない。 */
  model?: string;
  /** claude の --append-system-prompt にそのまま渡す（argv の 1 引数。shell は通らない）。空・未指定なら付けない。 */
  appendSystemPrompt?: string;
  /** claude の --add-dir に 1 つずつ渡す参照フォルダ（絶対パス）。空・未指定なら付けない。 */
  addDirs?: string[];
  cols?: number;
  rows?: number;
}): string[] {
  return [
    "--cols",
    String(opts.cols ?? DEFAULT_COLS),
    "--rows",
    String(opts.rows ?? DEFAULT_ROWS),
    "--",
    opts.claudePath,
    "--remote-control",
    opts.name,
    "--permission-mode",
    opts.permissionMode,
    ...(opts.model ? ["--model", opts.model] : []),
    ...(opts.appendSystemPrompt ? ["--append-system-prompt", opts.appendSystemPrompt] : []),
    ...(opts.addDirs ?? []).flatMap((d) => ["--add-dir", d]),
    ...(opts.mcpConfig ? ["--mcp-config", opts.mcpConfig] : []),
    ...(opts.settings ? ["--settings", opts.settings] : []),
    ...(opts.resume ? ["--continue"] : []),
  ];
}

/** 直近の text を保持する窓の大きさ（文字数）。 */
export const TEXT_WINDOW = 16 * 1024;

// URL の直後に URL 文字以外が続くものだけ（窓の末尾で切れた途中の URL は採らない）
const SESSION_URL_G = /https:\/\/claude\.ai\/code\/session_[A-Za-z0-9_-]+(?=[^A-Za-z0-9_-])/g;

/** 窓から最後の session URL を拾う。 */
export function findSessionUrl(win: string): string | undefined {
  return win.match(SESSION_URL_G)?.pop();
}

/** 窓が「remote-control 有効」を示すか（URL が見つかる、または状態行）。 */
export function windowConnected(win: string): boolean {
  return findSessionUrl(win) !== undefined || /\/remote-control is active/.test(win);
}
