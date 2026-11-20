/**
 * 「試す」: 接続して `initialize` → `tools/list`（ページを辿る）で道具の一覧が取れるかを確かめる。
 * 結果は分類（ok / unreachable / timeout / auth / not-found / protocol / config-error）で返す。
 * 先の error の文・URL・header・鍵は結果に含めない（SDK の例外の message は URL を含みうるので読まない）。
 * `event` など道具は呼ばない（initialize と tools/list だけ）。redirect は追わない（SDK の既定）。
 */
import { configHash, TIMEOUT_DEFAULT_MS, visibleToolNames, type McpConnection } from "./mcp-connections.js";
import type { ProbeKind } from "./mcp-status.js";

export interface ProbeResult {
  result: ProbeKind;
  httpStatus?: number;
  serverName?: string;
  serverVersion?: string;
  toolCount: number;
  visibleTools: string[];
  /** 役割 memory の接続で、先に `event`（前置き込み）があるか。 */
  hasEvent?: boolean;
  durationMs: number;
  configHash: string;
  toolsCopy?: unknown[];
}

export interface ProbeInput {
  conn: McpConnection;
  /** 鍵の値（auth がある接続だけ）。無ければ config-error。 */
  secret?: string;
  /** 識別の header の値（identity.header がある時）。 */
  identity: string;
  /** center の名前と版（initialize の clientInfo）。 */
  clientVersion?: string;
}

/** 先へ送る header を組み立てる（固定 → 識別 → 鍵の順。鍵と識別は固定の header より優先）。 */
export function buildHeaders(conn: McpConnection, secret: string | undefined, identity: string): Record<string, string> {
  const h: Record<string, string> = { ...(conn.headers ?? {}) };
  if (conn.identity) h[conn.identity.header] = conn.identity.value ?? identity;
  if (conn.auth && secret !== undefined) h[conn.auth.header ?? "Authorization"] = (conn.auth.format ?? "Bearer {secret}").replace("{secret}", () => secret);
  return h;
}

function classify(e: unknown, StreamableHTTPError: new (...a: never[]) => Error & { code?: number }, McpError: new (...a: never[]) => Error & { code?: number }): { kind: ProbeKind; httpStatus?: number } {
  if (e instanceof StreamableHTTPError) {
    const code = typeof e.code === "number" ? e.code : undefined;
    const httpStatus = code !== undefined && code > 0 ? code : undefined;
    if (code === 401 || code === 403) return { kind: "auth", httpStatus };
    if (code === 404) return { kind: "not-found", httpStatus };
    if (code !== undefined && code >= 500) return { kind: "unreachable", httpStatus };
    return { kind: "protocol", httpStatus };
  }
  if (e instanceof McpError) {
    if (e.code === -32001) return { kind: "timeout" };
    if (e.code === -32000) return { kind: "unreachable" };
    return { kind: "protocol" };
  }
  if (e instanceof Error && e.name === "TypeError" && e.message === "fetch failed") return { kind: "unreachable" };
  if (e instanceof Error && e.name === "UnauthorizedError") return { kind: "auth", httpStatus: 401 };
  return { kind: "protocol" };
}

class ProbeTimeout extends Error {}

export async function probeConnection(input: ProbeInput): Promise<ProbeResult> {
  const { conn } = input;
  const started = Date.now();
  const base = { configHash: configHash(conn), toolCount: 0, visibleTools: [] as string[] };
  const fin = (r: Omit<ProbeResult, "durationMs" | "configHash" | "toolCount" | "visibleTools"> & Partial<ProbeResult>): ProbeResult => ({
    ...base,
    ...r,
    durationMs: Date.now() - started,
  });
  if (conn.auth && (input.secret === undefined || input.secret === "")) return fin({ result: "config-error" });

  const [{ Client }, { StreamableHTTPClientTransport, StreamableHTTPError }, { McpError }] = await Promise.all([
    import("@modelcontextprotocol/sdk/client/index.js"),
    import("@modelcontextprotocol/sdk/client/streamableHttp.js"),
    import("@modelcontextprotocol/sdk/types.js"),
  ]);
  const headers = buildHeaders(conn, input.secret, input.identity);
  const client = new Client({ name: "bantou-center-test", version: input.clientVersion ?? "1" });
  const transport = new StreamableHTTPClientTransport(new URL(conn.url), { requestInit: { headers } });
  const limit = conn.timeoutMs ?? TIMEOUT_DEFAULT_MS;
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, rej) => {
    timer = setTimeout(() => rej(new ProbeTimeout()), limit);
    timer.unref();
  });
  deadline.catch(() => {});
  try {
    const work = (async () => {
      await client.connect(transport);
      const info = client.getServerVersion();
      const tools: Array<{ name: string }> = [];
      let cursor: string | undefined;
      for (let page = 0; page < 100; page++) {
        const res = await client.listTools(cursor ? { cursor } : undefined, { timeout: limit });
        tools.push(...(res.tools as Array<{ name: string }>));
        cursor = res.nextCursor;
        if (!cursor) break;
      }
      return { info, tools };
    })();
    work.catch(() => {});
    const { info, tools } = await Promise.race([work, deadline]);
    const names = tools.map((t) => t.name);
    return fin({
      result: "ok",
      serverName: info?.name,
      serverVersion: info?.version,
      toolCount: tools.length,
      visibleTools: visibleToolNames(conn, names),
      hasEvent: conn.role === "memory" ? names.includes(`${conn.toolPrefix ?? ""}event`) : undefined,
      toolsCopy: tools,
    });
  } catch (e) {
    if (e instanceof ProbeTimeout) return fin({ result: "timeout" });
    const c = classify(e, StreamableHTTPError as never, McpError as never);
    return fin({ result: c.kind, httpStatus: c.httpStatus });
  } finally {
    clearTimeout(timer);
    void client.close().catch(() => {});
  }
}
