// A fake center on 127.0.0.1 (ephemeral port). Port of the `Mock` of `center_mcp.rs` tests: initialize issues a
// session id, other requests need a known one (404 otherwise), tools/call answers over SSE.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export interface MockReq {
  headers: IncomingMessage["headers"];
  body: any;
}

export class FakeCenter {
  /** When set, every request must carry `Authorization: Bearer <this>` (401 otherwise). */
  requiredToken: string | undefined;
  sessions = new Set<string>();
  issued = 0;
  /** Number of GET requests seen. */
  gets = 0;
  log: MockReq[] = [];
  /** Per-tool canned result (JSON text of `content[0].text`); default echoes name and args. */
  tools = new Map<string, unknown>();
  /** Per-tool raw text (not JSON-encoded) of `content[0].text`. */
  rawTools = new Map<string, string>();
  /** Per-tool error text: the result has `isError: true`. */
  errorTools = new Map<string, string>();
  /** tools/call always answers 404 (a center that keeps forgetting our session). */
  dropCalls = false;
  /** Answer every request after this many with HTTP 500 "limit" (so a runaway retry ends with a count, not a hang). */
  limit: number | undefined;
  /** Take over a POST (after auth and logging). Return true when it answered. */
  override: ((method: string, req: IncomingMessage, res: ServerResponse) => boolean) | undefined;
  /** Extra handler for GET paths (e.g. /events). Return true when it handled the request. */
  onGet: ((req: IncomingMessage, res: ServerResponse) => boolean) | undefined;
  readonly server: Server;
  url = "";
  origin = "";

  constructor(requiredToken?: string) {
    this.requiredToken = requiredToken;
    this.server = createServer((req, res) => void this.handle(req, res));
  }

  static async start(requiredToken?: string): Promise<FakeCenter> {
    const c = new FakeCenter(requiredToken);
    await new Promise<void>((r) => c.server.listen(0, "127.0.0.1", r));
    const port = (c.server.address() as AddressInfo).port;
    c.origin = `http://127.0.0.1:${port}`;
    c.url = `${c.origin}/mcp`;
    return c;
  }

  async close(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((r) => this.server.close(() => r()));
  }

  /** The center restarted: every session id is forgotten. */
  restart(): void {
    this.sessions.clear();
  }

  methods(): string[] {
    return this.log.map((r) => r.body?.method ?? "");
  }

  count(method: string): number {
    return this.methods().filter((m) => m === method).length;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method === "GET") {
      this.gets += 1;
      if (this.limit !== undefined && this.gets > this.limit) {
        res.writeHead(500).end("limit");
        return;
      }
      if (this.onGet?.(req, res)) return;
      res.writeHead(404).end("not found");
      return;
    }
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    let body: any = null;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      // body stays null
    }
    const mreq: MockReq = { headers: req.headers, body };
    const method: string = body?.method ?? "";
    const id = body?.id;
    const sid = req.headers["mcp-session-id"] as string | undefined;
    const authorized =
      this.requiredToken === undefined || req.headers.authorization === `Bearer ${this.requiredToken}`;
    if (!authorized) {
      this.log.push(mreq);
      res.writeHead(401, { "www-authenticate": "Bearer" }).end("unauthorized");
      return;
    }
    const known = sid !== undefined && this.sessions.has(sid);
    this.log.push(mreq);
    if (this.limit !== undefined && this.log.length > this.limit) {
      res.writeHead(500).end("limit");
      return;
    }
    if (this.override?.(method, req, res)) return;
    const rpc = (result: unknown) => JSON.stringify({ jsonrpc: "2.0", id, result });
    if (method === "initialize") {
      this.issued += 1;
      const fresh = `s${this.issued}`;
      this.sessions.add(fresh);
      res
        .writeHead(200, { "content-type": "application/json", "mcp-session-id": fresh })
        .end(rpc({ protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "mock", version: "0" } }));
      return;
    }
    if (!known) {
      res
        .writeHead(404, { "content-type": "application/json" })
        .end('{"jsonrpc":"2.0","error":{"code":-32000,"message":"session が存在しない"},"id":null}');
      return;
    }
    if (method === "tools/call" && this.dropCalls) {
      res.writeHead(404, { "content-type": "application/json" }).end('{"error":"gone"}');
      return;
    }
    switch (method) {
      case "notifications/initialized":
        res.writeHead(202).end();
        return;
      case "ping":
        res.writeHead(200, { "content-type": "application/json" }).end(rpc({}));
        return;
      case "tools/call": {
        const name: string = body.params?.name ?? "";
        let result: unknown;
        if (name === "boom") {
          result = { content: [{ type: "text", text: '{"error":"kaboom"}' }], isError: true };
        } else if (this.errorTools.has(name)) {
          result = { content: [{ type: "text", text: this.errorTools.get(name) }], isError: true };
        } else if (this.rawTools.has(name)) {
          result = { content: [{ type: "text", text: this.rawTools.get(name) }] };
        } else if (this.tools.has(name)) {
          result = { content: [{ type: "text", text: JSON.stringify(this.tools.get(name)) }] };
        } else {
          result = {
            content: [{ type: "text", text: `{"tool":"${name}","args":${JSON.stringify(body.params?.arguments)}}` }],
          };
        }
        res.writeHead(200, { "content-type": "text/event-stream" }).end(`event: message\ndata: ${rpc(result)}\n\n`);
        return;
      }
      default:
        res.writeHead(400).end("unknown");
    }
  }
}

/** A port that nothing listens on. */
export async function deadUrl(): Promise<string> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const port = (s.address() as AddressInfo).port;
  await new Promise<void>((r) => s.close(() => r()));
  return `http://127.0.0.1:${port}/mcp`;
}
