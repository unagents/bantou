// The GraphQL relay: the browser's document goes to the center's `/graphql` with the center's token; the answer comes back as a stream.

import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, test } from "node:test";
import { createGraphqlRelay, MAX_GRAPHQL_BYTES, type GraphqlReply } from "../src/index.ts";

const TOKEN = "tok-ABCDEF123456-secret";
const Q = '{"query":"{ centerVersion { version } }"}';

interface Seen {
  method: string;
  url: string;
  auth: string | undefined;
  accept: string | undefined;
  body: string;
}

const servers: Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) {
    s.closeAllConnections();
    await new Promise<void>((r) => s.close(() => r()));
  }
});

async function fakeCenter(handler: (req: IncomingMessage, res: import("node:http").ServerResponse, seen: Seen) => void) {
  const seen: Seen[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const s = { method: req.method ?? "", url: req.url ?? "", auth: req.headers.authorization, accept: req.headers.accept, body: Buffer.concat(chunks).toString("utf8") };
      seen.push(s);
      handler(req, res, s);
    });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { seen, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp` };
}

async function text(r: GraphqlReply): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of r.body) chunks.push(Buffer.from(c as Uint8Array));
  return Buffer.concat(chunks).toString("utf8");
}

test("forwards the document with the center's token and returns the JSON answer", async () => {
  const c = await fakeCenter((_q, res) => {
    res.writeHead(200, { "content-type": "application/graphql-response+json" });
    res.end('{"data":{"centerVersion":{"version":"1"}}}');
  });
  const relay = createGraphqlRelay({ getTarget: async () => ({ url: c.url, token: TOKEN, source: "remote" }) });
  const r = await relay.forward('{"query":"{ centerVersion { version } }"}', undefined);
  assert.equal(r.status, 200);
  assert.equal(r.headers["content-type"], "application/graphql-response+json");
  assert.equal(await text(r), '{"data":{"centerVersion":{"version":"1"}}}');
  assert.deepEqual(c.seen, [{ method: "POST", url: "/graphql", auth: `Bearer ${TOKEN}`, accept: "application/json", body: '{"query":"{ centerVersion { version } }"}' }]);
});

test("a subscription (Accept: text/event-stream) comes back as a stream, and close() ends the center's request", async () => {
  let closed = false;
  const c = await fakeCenter((_q, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write("event: next\ndata: {}\n\n");
    res.on("close", () => (closed = true));
  });
  const relay = createGraphqlRelay({ getTarget: async () => ({ url: c.url, token: TOKEN, source: "remote" }) });
  const r = await relay.forward('{"query":"subscription { sessionsChanged { name } }"}', "text/event-stream");
  assert.equal(r.headers["cache-control"], "no-cache, no-transform");
  assert.equal(c.seen[0]!.accept, "text/event-stream");
  const first = await new Promise<string>((resolve) => r.body.once("data", (d: Buffer) => resolve(d.toString())));
  assert.equal(first, "event: next\ndata: {}\n\n");
  r.close();
  for (let i = 0; i < 50 && !closed; i++) await new Promise((x) => setTimeout(x, 20));
  assert.equal(closed, true);
});

test("no target, an unreachable center and a too large body are JSON errors, never a throw", async () => {
  const none = createGraphqlRelay({ getTarget: async () => undefined });
  const a = await none.forward(Q, undefined);
  assert.equal(a.status, 503);
  assert.match(await text(a), /errors/);

  const dead = createGraphqlRelay({ getTarget: async () => ({ url: "http://127.0.0.1:1/mcp", token: TOKEN, source: "remote" }) });
  const b = await dead.forward(Q, undefined);
  assert.equal(b.status, 502);
  assert.ok(!(await text(b)).includes(TOKEN));

  const big = await none.forward("x".repeat(MAX_GRAPHQL_BYTES + 1), undefined);
  assert.equal(big.status, 413);
});
