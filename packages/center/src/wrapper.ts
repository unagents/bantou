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

/** --mcp-config に渡す JSON 文字列。token は ${BANTOU_SESSION_TOKEN} のまま（claude が環境変数から展開する）。 */
export function mcpConfigJson(url: string, session: string): string {
  return JSON.stringify({
    mcpServers: {
      bantou: {
        type: "http",
        url,
        headers: { Authorization: "Bearer ${BANTOU_SESSION_TOKEN}", "X-Bantou-Session": session },
      },
    },
  });
}

export const DEFAULT_COLS = 120;
export const DEFAULT_ROWS = 40;

/** wrapper の引数全体（wrapper 自身のオプション + `--` + claude とその引数）。 */
export function buildWrapperArgs(opts: {
  claudePath: string;
  name: string;
  permissionMode: string;
  mcpConfig: string | null;
  resume: boolean;
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
    ...(opts.mcpConfig ? ["--mcp-config", opts.mcpConfig] : []),
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
