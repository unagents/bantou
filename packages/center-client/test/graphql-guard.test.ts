// The web's guards on the GraphQL relay: a mutation not on the web's list and a write of a center-only setting are
// refused (403) before anything reaches the center, and no answer carries the center's token to the browser.

import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, test } from "node:test";
import { createGraphqlRelay, createRedactor, graphqlRefusal, type GraphqlReply, type Target } from "../src/index.ts";

const TOKEN = "tok-ABCDEF123456-secret";
const body = (query: string, variables?: Record<string, unknown>) => JSON.stringify({ query, ...(variables ? { variables } : {}) });

const servers: Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) {
    s.closeAllConnections();
    await new Promise<void>((r) => s.close(() => r()));
  }
});

async function center(handler: (res: import("node:http").ServerResponse) => void | Promise<void>) {
  let hits = 0;
  const server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      hits++;
      void handler(res);
    });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const target: Target = { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`, token: TOKEN, source: "remote" };
  return { target, hits: () => hits };
}

async function text(r: GraphqlReply): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of r.body) chunks.push(Buffer.from(c as Uint8Array));
  return Buffer.concat(chunks).toString("utf8");
}

test("refusal: a mutation not on the web's list is 403 (session deletion, replyWorker, an unknown one)", () => {
  for (const f of ['deleteSession(name: "a")', 'replyWorker(server: "s", sessionId: "x", order: "answer")', "somethingNew"]) {
    assert.equal(graphqlRefusal(body(`mutation { ${f} }`))?.status, 403, f);
  }
});

test("refusal: an allowed mutation and queries / subscriptions pass", () => {
  assert.equal(graphqlRefusal(body('mutation { sleepSession(name: "a") { name } }')), undefined);
  assert.equal(graphqlRefusal(body('mutation M($n: String!) { restartSession(name: $n) }', { n: "a" })), undefined);
  assert.equal(graphqlRefusal(body("{ sessions { reachable } }")), undefined);
  assert.equal(graphqlRefusal(body("subscription { sessionsChanged { name } }")), undefined);
  assert.equal(graphqlRefusal(body('mutation { updateCenterSettings(settings: { instructions: "x", openspecUrl: "http://h/mcp" }) { instructions } }')), undefined);
});

test("refusal: a center-only key in settings is 403 — inline, by variable, null too, behind an alias", () => {
  const bad = [
    body('mutation { updateCenterSettings(settings: { memory: { type: "http" } }) { instructions } }'),
    body("mutation($s: CenterSettingsInput!) { updateCenterSettings(settings: $s) { instructions } }", { s: { mcpServers: { a: {} } } }),
    body("mutation($m: JSON) { updateSessionSettings(name: \"a\", settings: { mcpSecrets: $m }) { instructions } }", { m: { k: "v" } }),
    body('mutation { x: updateSessionSettings(name: "a", settings: { coordinator: null }) { instructions } }'),
    body('mutation($s: ProjectSettingsInput) { createSession(name: "a", settings: $s) { name } }', { s: { projectMemory: {} } }),
  ];
  for (const b of bad) assert.equal(graphqlRefusal(b)?.status, 403, b);
});

test("refusal: an alias cannot hide a mutation; a fragment at the root and every mutation of the document are checked", () => {
  assert.equal(graphqlRefusal(body('mutation { sleepSession: deleteSession(name: "a") }'))?.status, 403);
  assert.equal(graphqlRefusal(body("mutation { ...F } fragment F on Mutation { deleteSession(name: \"a\") }"))?.status, 403);
  assert.equal(graphqlRefusal(body('mutation A { sleepSession(name: "a") { name } } mutation B { deleteSession(name: "a") }') )?.status, 403);
});

test("refusal: what cannot be checked is 400 (not JSON, no query, a batch, not GraphQL)", () => {
  assert.equal(graphqlRefusal("nope")?.status, 400);
  assert.equal(graphqlRefusal("{}")?.status, 400);
  assert.equal(graphqlRefusal("[]")?.status, 400);
  assert.equal(graphqlRefusal(JSON.stringify([{ query: "{ a }" }]))?.status, 400);
  assert.equal(graphqlRefusal(body("mutation {"))?.status, 400);
});

test("relay: a refused mutation is 403 and never reaches the center", async () => {
  const c = await center((res) => void res.end("{}"));
  const relay = createGraphqlRelay({ getTarget: async () => c.target });
  const r = await relay.forward(body('mutation { updateCenterSettings(settings: { memory: null }) { instructions } }'), undefined);
  assert.equal(r.status, 403);
  assert.match(await text(r), /errors/);
  assert.equal(c.hits(), 0);
});

test("relay: the center's token in a JSON answer (a plain one and an error) never reaches the browser", async () => {
  const c = await center((res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ data: { centerSettings: { mcpServers: { a: { headers: { Authorization: `Bearer ${TOKEN}` } } } } }, errors: [{ message: `bad ${TOKEN}` }] }));
  });
  const redactor = createRedactor({ selectTarget: async () => c.target });
  const relay = createGraphqlRelay({ getTarget: async () => c.target, redactor });
  const out = await text(await relay.forward(body("{ centerSettings { mcpServers } }"), undefined));
  assert.ok(!out.includes(TOKEN));
  assert.ok(out.includes("***"));
  JSON.parse(out);
});

test("relay: a token split across two chunks of an SSE stream is still cleaned (frames, not chunks)", async () => {
  const c = await center(async (res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    const frame = `event: next\ndata: {"data":{"x":"${TOKEN}"}}\n\n`;
    const cut = frame.indexOf(TOKEN) + 8;
    res.write(frame.slice(0, cut));
    await new Promise((r) => setTimeout(r, 50));
    res.write(frame.slice(cut));
    res.write("event: next\ndata: {}\n\n");
    res.end("event: complete\ndata:");
  });
  const redactor = createRedactor({ selectTarget: async () => c.target });
  const relay = createGraphqlRelay({ getTarget: async () => c.target, redactor });
  const out = await text(await relay.forward(body("subscription { sessionsChanged { name } }"), "text/event-stream"));
  assert.ok(!out.includes(TOKEN));
  assert.ok(out.startsWith('event: next\ndata: {"data":{"x":"***"}}\n\nevent: next\ndata: {}\n\n'));
  assert.ok(out.endsWith("event: complete\ndata:"));
});
