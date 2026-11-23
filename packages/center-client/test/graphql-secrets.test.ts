// The web's view of the settings secrets on the GraphQL relay: values are masked in the answer (items stay), and a write
// that sends the masked form back changes nothing for that item.

import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, test } from "node:test";
import { maskItem, maskUrl } from "../src/graphql-secrets.ts";
import { createGraphqlRelay, maskGraphqlAnswer, type GraphqlReply, type Target } from "../src/index.ts";

const body = (query: string, variables?: Record<string, unknown>) => JSON.stringify({ query, ...(variables ? { variables } : {}) });

const STORED = {
  memory: { type: "http", url: "http://m/mcp", headers: { Authorization: "Bearer mem-SECRET-1" }, token: "mem-TOKEN-2" },
  mcpServers: {
    a: { type: "http", url: "http://u:pw-SECRET-15@a/mcp?key=qs-SECRET-16&v=1", headers: { "X-Key": "hdr-SECRET-3" } },
    b: { command: "node", args: ["x.js"], env: { API: "env-SECRET-4" } },
  },
  mcpSecrets: { conn: { key: "sec-SECRET-5" }, flat: "sec-SECRET-6" },
};
const MASKED = {
  memory: { type: "http", url: "http://m/mcp", headers: { Authorization: "***" }, token: "***" },
  mcpServers: {
    a: { type: "http", url: "http://***@a/mcp?key=***&v=***", headers: { "X-Key": "***" } },
    b: { command: "node", args: ["x.js"], env: { API: "***" } },
  },
  mcpSecrets: { conn: { key: "***" }, flat: "***" },
};

const servers: Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) {
    s.closeAllConnections();
    await new Promise<void>((r) => s.close(() => r()));
  }
});

/** A center that answers every settings read with STORED and records the documents it gets. */
async function center() {
  const seen: { query: string; variables: Record<string, unknown> }[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const j = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { query: string; variables?: Record<string, unknown> };
      seen.push({ query: j.query, variables: j.variables ?? {} });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: { sessionSettings: STORED, centerSettings: STORED, updateCenterSettings: STORED, updateSessionSettings: STORED } }));
    });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const target: Target = { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`, token: "tok-ABCDEF123456-secret", source: "remote" };
  return { target, seen };
}

async function text(r: GraphqlReply): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of r.body) chunks.push(Buffer.from(c as Uint8Array));
  return Buffer.concat(chunks).toString("utf8");
}

test("answer: no secret value reaches the web, every item stays", async () => {
  const c = await center();
  const relay = createGraphqlRelay({ getTarget: async () => c.target });
  const out = await text(await relay.forward(body("{ centerSettings { memory mcpServers mcpSecrets } }"), undefined));
  for (const s of ["mem-SECRET-1", "mem-TOKEN-2", "hdr-SECRET-3", "env-SECRET-4", "sec-SECRET-5", "sec-SECRET-6", "pw-SECRET-15", "qs-SECRET-16"]) assert.ok(!out.includes(s), s);
  assert.deepEqual((JSON.parse(out) as { data: { centerSettings: unknown } }).data.centerSettings, MASKED);
});

test("answer: an alias and a session's settings are masked too; other values are left", () => {
  const out = JSON.parse(maskGraphqlAnswer(body("{ s: sessionSettings(name: \"a\") { m: mcpSecrets instructions } }"), JSON.stringify({ data: { s: { m: { k: "v" }, instructions: "hello" } } }))) as { data: { s: unknown } };
  assert.deepEqual(out.data.s, { m: { k: "***" }, instructions: "hello" });
  assert.equal(maskGraphqlAnswer("{}", "not json"), "not json");
});

test("write: the masked form sent back leaves the item unchanged (it never reaches the center)", async () => {
  const c = await center();
  const relay = createGraphqlRelay({ getTarget: async () => c.target });
  const q = "mutation($s: CenterSettingsInput!) { updateCenterSettings(settings: $s) { instructions } }";
  const r = await relay.forward(body(q, { s: { instructions: "new", ...MASKED } }), undefined);
  assert.equal(r.status, 200);
  await text(r);
  const write = c.seen.find((s) => s.query.includes("updateCenterSettings"))!;
  assert.deepEqual(write.variables, { s: { instructions: "new" } });
  assert.ok(!JSON.stringify(c.seen).includes("***"));
});

test("write: a session's masked form is compared with that session's settings", async () => {
  const c = await center();
  const relay = createGraphqlRelay({ getTarget: async () => c.target });
  const q = "mutation($n: String!, $s: ProjectSettingsInput!) { updateSessionSettings(name: $n, settings: $s) { instructions } }";
  const r = await relay.forward(body(q, { n: "a", s: { mcpSecrets: MASKED.mcpSecrets } }), undefined);
  assert.equal(r.status, 200);
  await text(r);
  assert.deepEqual(c.seen[0]!.variables, { n: "a" });
  assert.deepEqual(c.seen[1]!.variables, { n: "a", s: {} });
});

test("write: a changed item (even with `***` in it) is refused as before, and `***` is never forwarded", async () => {
  const c = await center();
  const relay = createGraphqlRelay({ getTarget: async () => c.target });
  const q = "mutation($s: CenterSettingsInput!) { updateCenterSettings(settings: $s) { instructions } }";
  const edited = { mcpServers: { ...MASKED.mcpServers, a: { ...MASKED.mcpServers.a, url: "http://evil/mcp" } } };
  const r = await relay.forward(body(q, { s: edited }), undefined);
  assert.equal(r.status, 403);
  assert.ok(!c.seen.some((s) => s.query.includes("updateCenterSettings")));
  // a literal `***` (not a variable), and a value that is not the masked current one
  const inline = await relay.forward(body('mutation { updateCenterSettings(settings: { mcpSecrets: { k: "***" } }) { instructions } }'), undefined);
  assert.equal(inline.status, 403);
  const other = await relay.forward(body(q, { s: { mcpSecrets: { k: "***" } } }), undefined);
  assert.equal(other.status, 403);
});

test("write: when the current settings cannot be read, the masked form is refused", async () => {
  const relay = createGraphqlRelay({ getTarget: async () => ({ url: "http://127.0.0.1:1/mcp", token: "t", source: "remote" }) });
  const q = "mutation($s: CenterSettingsInput!) { updateCenterSettings(settings: $s) { instructions } }";
  const r = await relay.forward(body(q, { s: { mcpSecrets: MASKED.mcpSecrets } }), undefined);
  assert.equal(r.status, 403);
});

const OLD_STORED = {
  projectMemory: { type: "http", url: "http://pm/mcp", headers: { Authorization: "Bearer pm-SECRET-7" }, token: "pm-TOKEN-8" },
  mcp: { url: "http://old/mcp", token: "old-TOKEN-9", headers: { "X-Key": "old-HDR-10" }, env: { K: "old-ENV-11" } },
  mcpConnections: { conn: { url: "http://c/mcp", headers: { Authorization: "conn-HDR-12" }, env: { K: "conn-ENV-13" }, token: "conn-TOKEN-14" } },
};
const OLD_MASKED = {
  projectMemory: { type: "http", url: "http://pm/mcp", headers: { Authorization: "***" }, token: "***" },
  mcp: { url: "http://old/mcp", token: "***", headers: { "X-Key": "***" }, env: { K: "***" } },
  mcpConnections: { conn: { url: "http://c/mcp", headers: { Authorization: "***" }, env: { K: "***" }, token: "***" } },
};

test("answer: projectMemory and the old mcp / mcpConnections are masked too (items stay, other values left)", () => {
  const out = JSON.parse(maskGraphqlAnswer(body("{ centerSettings { projectMemory mcp mcpConnections } }"), JSON.stringify({ data: { centerSettings: OLD_STORED } }))) as { data: { centerSettings: unknown } };
  assert.deepEqual(out.data.centerSettings, OLD_MASKED);
});

test("write: the masked projectMemory / mcp / mcpConnections sent back is unchanged; an edited one is refused", async () => {
  const stored = { ...STORED, ...OLD_STORED };
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const j = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { query: string; variables?: Record<string, unknown> };
      seen.push({ query: j.query, variables: j.variables ?? {} });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: { centerSettings: stored, updateCenterSettings: stored } }));
    });
  });
  const seen: { query: string; variables: Record<string, unknown> }[] = [];
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const target: Target = { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`, token: "tok-ABCDEF123456-secret", source: "remote" };
  const relay = createGraphqlRelay({ getTarget: async () => target });
  const q = "mutation($s: CenterSettingsInput!) { updateCenterSettings(settings: $s) { instructions } }";
  const r = await relay.forward(body(q, { s: { instructions: "new", ...OLD_MASKED } }), undefined);
  assert.equal(r.status, 200);
  await text(r);
  assert.deepEqual(seen.find((s) => s.query.includes("updateCenterSettings"))!.variables, { s: { instructions: "new" } });
  assert.ok(!JSON.stringify(seen).includes("***"));
  const edited = await relay.forward(body(q, { s: { mcp: { ...OLD_MASKED.mcp, url: "http://evil/mcp" } } }), undefined);
  assert.equal(edited.status, 403);
  const other = await relay.forward(body(q, { s: { projectMemory: { token: "***", url: "http://x" } } }), undefined);
  assert.equal(other.status, 403);
});

test("desktop (guard off): the answer is not masked", async () => {
  const c = await center();
  const relay = createGraphqlRelay({ getTarget: async () => c.target, guard: false });
  const out = await text(await relay.forward(body("{ centerSettings { mcpSecrets } }"), undefined));
  assert.ok(out.includes("sec-SECRET-5"));
});

test("url: the userinfo and the query values are masked, the rest is kept; masking again changes nothing", () => {
  const cases: [string, string][] = [
    ["http://u:p@h:8080/mcp?k=v&x=1#f", "http://***@h:8080/mcp?k=***&x=***#f"],
    ["https://h/mcp?token=abc", "https://h/mcp?token=***"],
    ["https://tok@h/mcp", "https://***@h/mcp"],
    ["http://h/mcp", "http://h/mcp"],
    ["http://h/mcp?a=&b", "http://h/mcp?a=&b=***".replace("b=***", "***")],
  ];
  for (const [from, to] of cases) {
    assert.equal(maskUrl(from), to, from);
    assert.equal(maskUrl(to), to, to);
  }
  assert.deepEqual(maskItem("memory", { url: "http://u:p@h/m?k=v" }), { url: "http://***@h/m?k=***" });
  assert.deepEqual(maskItem("mcp", { url: "http://u:p@h/m?k=v" }), { url: "http://***@h/m?k=***" });
  assert.deepEqual(maskItem("projectMemory", { url: "http://u:p@h/m" }), { url: "http://***@h/m" });
  assert.deepEqual(maskItem("mcpConnections", { c: { url: "http://h/m?k=v" } }), { c: { url: "http://h/m?k=***" } });
  assert.deepEqual(maskItem("mcpServers", { a: { url: "http://h/m?k=v", args: ["http://u:p@h/?k=v"] } }), { a: { url: "http://h/m?k=***", args: ["http://u:p@h/?k=v"] } });
});
