/**
 * memory 本体の fake（MCP Streamable HTTP の最小実装。packages/memory の本物は起動しない）。
 * tool `event` だけを持ち、memory の入力検証（eventId 1..128・kind・body 1..65536・NUL 不可・at は +1 日まで）と
 * (X-Agent-Id, eventId) の冪等（2 回目は duplicate）を再現する。packages/server/test/helpers/fake-memory.ts と同じ内容。
 */
import { createServer, type IncomingMessage, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

export interface FakeEventCall {
  agentId: string | undefined;
  authorization: string | undefined;
  args: Record<string, unknown>;
  status: "recorded" | "duplicate" | "invalid";
}

export interface FakeMemory {
  url: string;
  token: string;
  /** tool の呼び出し（検証後の結果つき）。 */
  calls: FakeEventCall[];
  /** 記録された event（duplicate / invalid を除く）。 */
  recorded: () => Array<Record<string, unknown> & { agentId: string | undefined }>;
  /** 次の n 回の HTTP request を 500 で落とす。 */
  failNext(n: number): void;
  /** true の間、全 request を 500 で落とす。 */
  setDown(down: boolean): void;
  /** token が違う request は 401。 */
  close(): Promise<void>;
}

const EVENT_KINDS = ["user_prompt", "assistant_message", "task", "result", "report", "reply"];

function validate(a: Record<string, unknown>): string | undefined {
  const idOk = (v: unknown): boolean => typeof v === "string" && v.length >= 1 && v.length <= 128 && !v.includes("\u0000");
  if (!idOk(a.eventId)) return "eventId";
  if (typeof a.sender !== "object" || a.sender === null) return "sender";
  if (!EVENT_KINDS.includes(a.kind as string)) return "kind";
  if (typeof a.body !== "string" || a.body.length < 1 || a.body.length > 65536 || a.body.includes("\u0000")) return "body";
  if (typeof a.at !== "string" || Number.isNaN(Date.parse(a.at)) || Date.parse(a.at) > Date.now() + 86_400_000) return "at";
  for (const k of ["remoteId", "taskId"]) if (a[k] !== undefined && !idOk(a[k])) return k;
  return undefined;
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const t = Buffer.concat(chunks).toString("utf8");
  return t ? JSON.parse(t) : undefined;
}

export async function startFakeMemory(token = "FAKE-MEMORY-TOKEN"): Promise<FakeMemory> {
  const calls: FakeEventCall[] = [];
  const seen = new Set<string>();
  let failures = 0;
  let down = false;
  const sockets = new Set<import("node:net").Socket>();

  const http: HttpServer = createServer((req, res) => {
    void (async () => {
      if (down || failures > 0) {
        if (failures > 0) failures -= 1;
        res.writeHead(500).end("boom");
        return;
      }
      if (req.headers.authorization !== `Bearer ${token}`) {
        res.writeHead(401).end("unauthorized");
        return;
      }
      const agentId = typeof req.headers["x-agent-id"] === "string" ? req.headers["x-agent-id"] : undefined;
      const mcp = new Server({ name: "fake-memory", version: "0" }, { capabilities: { tools: {} } });
      mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: "event", inputSchema: { type: "object" as const, properties: {} } }] }));
      mcp.setRequestHandler(CallToolRequestSchema, async (r) => {
        const args = (r.params.arguments ?? {}) as Record<string, unknown>;
        const bad = validate(args);
        if (bad) {
          calls.push({ agentId, authorization: req.headers.authorization, args, status: "invalid" });
          return { isError: true, content: [{ type: "text" as const, text: `invalid: ${bad}` }] };
        }
        const key = `${agentId}\u0000${String(args.eventId)}`;
        const dup = seen.has(key);
        seen.add(key);
        calls.push({ agentId, authorization: req.headers.authorization, args, status: dup ? "duplicate" : "recorded" });
        return { content: [{ type: "text" as const, text: JSON.stringify({ status: dup ? "duplicate" : "recorded", eventId: args.eventId }) }] };
      });
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on("close", () => void transport.close());
      await mcp.connect(transport);
      await transport.handleRequest(req, res, await readBody(req));
    })().catch(() => {
      if (!res.headersSent) res.writeHead(500).end("error");
    });
  });
  http.on("connection", (s) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });
  await new Promise<void>((r) => http.listen(0, "127.0.0.1", r));
  const port = (http.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    token,
    calls,
    recorded: () => calls.filter((c) => c.status === "recorded").map((c) => ({ ...c.args, agentId: c.agentId })),
    failNext: (n) => void (failures = n),
    setDown: (d) => void (down = d),
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        http.close(() => resolve());
      }),
  };
}
