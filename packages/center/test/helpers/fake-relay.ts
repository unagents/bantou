/**
 * テスト用の偽の MCP の中継（127.0.0.1 の空き port だけ）。Streamable HTTP の最小の実装（JSON 応答）。
 * 鍵の header の名前と値の形を切り替えられ、受けた request の header を記録し、
 * 落ちている・認証の失敗・遅い・壊れた応答・道具の一覧を返す、を切り替えられる。実の中継には接続しない。
 */
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export type RelayMode = "ok" | "drop" | "unauthorized" | "forbidden" | "notfound" | "unavailable" | "slow" | "broken";

export interface RelayOptions {
  /** 鍵を受ける header 名（小文字）。 */
  authHeader?: string;
  /** `bearer` = `Bearer <鍵>`、`raw` = 鍵そのまま。 */
  authFormat?: "bearer" | "raw";
  secret: string;
  mode?: RelayMode;
  slowMs?: number;
  /** 1 ページの道具の数（無ければ全部を 1 ページ）。 */
  pageSize?: number;
  tools?: string[];
}

export interface RecordedRequest {
  method: string;
  headers: IncomingHttpHeaders;
  rpcMethod?: string;
}

export const DEFAULT_TOOLS = ["memory-event", "memory-recall", "memory-context", "search-find", "admin-drop", "recall"];

export interface FakeRelay {
  url: string;
  port: number;
  mode: RelayMode;
  requests: RecordedRequest[];
  /** tools/call の記録（試すだけでは呼ばれない事の確認用）。 */
  toolCalls: string[];
  close(): Promise<void>;
}

export async function startFakeRelay(opts: RelayOptions): Promise<FakeRelay> {
  const authHeader = (opts.authHeader ?? "authorization").toLowerCase();
  const tools = opts.tools ?? DEFAULT_TOOLS;
  const expected = opts.authFormat === "raw" ? opts.secret : `Bearer ${opts.secret}`;
  const state: FakeRelay = { url: "", port: 0, mode: opts.mode ?? "ok", requests: [], toolCalls: [], close: async () => {} };
  const sockets = new Set<import("node:net").Socket>();
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      let rpc: { id?: number; method?: string; params?: Record<string, unknown> } | undefined;
      try {
        rpc = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined;
      } catch {
        rpc = undefined;
      }
      state.requests.push({ method: req.method ?? "", headers: req.headers, rpcMethod: rpc?.method });
      const respond = (): void => {
        const mode = state.mode;
        if (mode === "unauthorized" || req.headers[authHeader] !== expected) {
          res.writeHead(401, { "content-type": "text/plain" }).end("unauthorized");
          return;
        }
        if (mode === "forbidden") return void res.writeHead(403).end("forbidden");
        if (mode === "notfound") return void res.writeHead(404).end("not found");
        if (mode === "unavailable") return void res.writeHead(503).end("unavailable");
        if (mode === "broken") return void res.writeHead(200, { "content-type": "text/plain" }).end("this is not MCP");
        if (req.method === "DELETE") return void res.writeHead(200).end();
        if (req.method !== "POST" || !rpc) return void res.writeHead(405).end();
        const json = (result: unknown): void => {
          res.writeHead(200, { "content-type": "application/json", "mcp-session-id": "fake-session" }).end(JSON.stringify({ jsonrpc: "2.0", id: rpc?.id, result }));
        };
        if (rpc.method === "initialize") {
          return json({ protocolVersion: (rpc.params?.protocolVersion as string) ?? "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "fake-relay", version: "0.0.1" } });
        }
        if (rpc.method?.startsWith("notifications/")) return void res.writeHead(202).end();
        if (rpc.method === "tools/list") {
          const start = rpc.params?.cursor ? Number(rpc.params.cursor) : 0;
          const size = opts.pageSize ?? tools.length;
          const page = tools.slice(start, start + size);
          const next = start + size < tools.length ? String(start + size) : undefined;
          return json({ tools: page.map((name) => ({ name, description: `${name} tool`, inputSchema: { type: "object", properties: {} } })), ...(next ? { nextCursor: next } : {}) });
        }
        if (rpc.method === "tools/call") {
          state.toolCalls.push(String(rpc.params?.name));
          return json({ content: [{ type: "text", text: "called" }] });
        }
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, error: { code: -32601, message: "no" } }));
      };
      if (state.mode === "drop") return void req.socket.destroy();
      if (state.mode === "slow") setTimeout(() => (res.destroyed ? undefined : respond()), opts.slowMs ?? 3000).unref();
      else respond();
    });
  });
  server.on("connection", (s) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  state.port = (server.address() as AddressInfo).port;
  state.url = `http://127.0.0.1:${state.port}/mcp`;
  state.close = () =>
    new Promise<void>((r) => {
      for (const s of sockets) s.destroy();
      server.close(() => r());
    });
  return state;
}

/** 空いている port を 1 つ取って閉じる（そこへは誰も待ち受けていない = 落ちている）。 */
export async function closedPortUrl(): Promise<string> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const port = (s.address() as AddressInfo).port;
  await new Promise<void>((r) => s.close(() => r()));
  return `http://127.0.0.1:${port}/mcp`;
}
