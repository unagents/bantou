import assert from "node:assert/strict";
import { createServer as createHttpServer, request as httpRequest, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { startHttpServer } from "../src/http.js";
import { buildSessionMcp } from "../src/mcp-session.js";
import { connectionsFromSettings } from "../src/mcp-connections.js";
import { expandEnvRefs } from "../src/mcp-server-def.js";
import type { GuardrailSchema } from "../src/project-settings.js";
import {
  applySchemaDiscoveryEnv,
  SCHEMA_DISCOVERY_ENV,
  SCHEMA_DISCOVERY_HEADER,
  SCHEMA_MCP_PATH,
  schemaDiscoveryValue,
  schemaSourceFromFile,
  schemaTokenOf,
} from "../src/schema-server.js";

const TOKEN = "test-token-0123456789";
const ACCEPT = "application/json, text/event-stream";

const def = (schema: string, templates: Record<string, string> = {}): GuardrailSchema => ({ schema, templates });

async function boot(initial: Record<string, GuardrailSchema>) {
  const schemas = { ...initial };
  const h = await startHttpServer({
    createServer: () => new McpServer({ name: "x", version: "0" }),
    schemas: () => schemas,
    port: 0,
    bind: "127.0.0.1",
    token: TOKEN,
    log: () => {},
  });
  const url = `http://127.0.0.1:${h.port}${SCHEMA_MCP_PATH}`;
  const auth = { authorization: `Bearer ${schemaTokenOf(TOKEN)}` };
  return { h, schemas, url, auth, port: h.port };
}

/** JSON-RPC を 1 回 POST する（stateless。session を張らない）。 */
async function rpc(url: string, headers: Record<string, string>, method: string, params?: unknown) {
  const r = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: ACCEPT, ...headers },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, ...(params === undefined ? {} : { params }) }),
  });
  const text = await r.text();
  return { status: r.status, type: r.headers.get("content-type") ?? "", sid: r.headers.get("mcp-session-id"), json: text ? (JSON.parse(text) as Record<string, any>) : undefined };
}

test("schema server: 認証は schema 用の token だけ。center の token・無し・別の値は 401。GET・DELETE は 405", async () => {
  const { h, url, auth } = await boot({ a: def("A") });
  try {
    assert.equal((await rpc(url, {}, "resources/list")).status, 401);
    assert.equal((await rpc(url, { authorization: `Bearer ${TOKEN}` }, "resources/list")).status, 401, "center の token では入れない");
    assert.equal((await rpc(url, { authorization: "Bearer nope" }, "resources/list")).status, 401);
    assert.equal((await rpc(url, auth, "resources/list")).status, 200);
    assert.equal((await fetch(url, { headers: auth })).status, 405);
    assert.equal((await fetch(url, { method: "DELETE", headers: auth })).status, 405);
    // schema 用の token では /mcp は使えない
    const r = await fetch(`http://127.0.0.1:${h.port}/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: ACCEPT, ...auth }, body: "{}" });
    assert.equal(r.status, 401);
  } finally {
    await h.close();
  }
});

test("schema server: loopback の待受では Host が自分宛でない呼び出し（DNS rebinding）は 403", async () => {
  const { h, port, auth } = await boot({ a: def("A") });
  try {
    const status = await new Promise<number>((resolve, reject) => {
      const req = httpRequest(
        { host: "127.0.0.1", port, path: SCHEMA_MCP_PATH, method: "POST", headers: { ...auth, host: "evil.example", "content-type": "application/json", accept: ACCEPT } },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on("error", reject);
      req.end(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "resources/list" }));
    });
    assert.equal(status, 403);
  } finally {
    await h.close();
  }
});

test("schema server: stateless・JSON 応答（session id も SSE も無い）。initialize を通さなくても resources/list に答える。capability は resources", async () => {
  const { h, url, auth } = await boot({ a: def("A") });
  try {
    const l = await rpc(url, auth, "resources/list");
    assert.match(l.type, /^application\/json/);
    assert.equal(l.sid, null);
    const i = await rpc(url, auth, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } });
    assert.equal(i.status, 200);
    assert.match(i.type, /^application\/json/);
    assert.equal(i.sid, null);
    assert.deepEqual(Object.keys(i.json!.result.capabilities), ["resources"]);
  } finally {
    await h.close();
  }
});

test("schema server: resources/list は全件を 1 回の応答で返す（名前の昇順・cursor 無し）。template の一覧は schema:///schemas/{name}", async () => {
  const names = ["b", "A", "a.b-c_d", "z9", ...Array.from({ length: 120 }, (_, i) => `n${String(i).padStart(3, "0")}`)];
  const { h, url, auth } = await boot(Object.fromEntries(names.map((n) => [n, def(n)])));
  try {
    const l = await rpc(url, auth, "resources/list");
    const got = l.json!.result.resources as { uri: string; name: string; mimeType: string }[];
    assert.equal(got.length, names.length);
    assert.equal(l.json!.result.nextCursor, undefined);
    assert.deepEqual(got.map((r) => r.name), [...names].sort());
    for (const r of got) {
      assert.equal(r.uri, `schema:///schemas/${r.name}`);
      assert.equal(r.mimeType, "application/json");
    }
    const t = await rpc(url, auth, "resources/templates/list");
    assert.deepEqual(t.json!.result.resourceTemplates.map((x: { uriTemplate: string }) => x.uriTemplate), ["schema:///schemas/{name}"]);
  } finally {
    await h.close();
  }
});

test("schema server: resources/read は contents がちょうど 1 件。uri は要求と完全一致、mimeType は application/json、text は { name, schema, templates } の JSON", async () => {
  const yaml = "name: spec-driven\nartifacts:\n  - id: proposal\n    generates: proposal.md\n";
  const { h, url, auth } = await boot({ "Spec.driven-1_x": def(yaml, { "proposal.md": "# {{title}}\n", "sub/dir/t.md": "日本語\n" }), empty: def("") });
  try {
    const uri = "schema:///schemas/Spec.driven-1_x";
    const r = await rpc(url, auth, "resources/read", { uri });
    assert.equal(r.json!.result.contents.length, 1);
    const c = r.json!.result.contents[0];
    assert.equal(c.uri, uri);
    assert.equal(c.mimeType, "application/json");
    assert.deepEqual(JSON.parse(c.text), { name: "Spec.driven-1_x", schema: yaml, templates: { "proposal.md": "# {{title}}\n", "sub/dir/t.md": "日本語\n" } });
    const e = await rpc(url, auth, "resources/read", { uri: "schema:///schemas/empty" });
    assert.deepEqual(JSON.parse(e.json!.result.contents[0].text), { name: "empty", schema: "", templates: {} });
  } finally {
    await h.close();
  }
});

test("schema server: 無い名前・規則外の名前（正規化も別の schema を返す事もしない）・template に合わない URI は -32002（data.uri）", async () => {
  const { h, url, auth } = await boot({ a: def("A"), "a-b": def("AB"), A: def("UP"), "-x": def("X") as GuardrailSchema });
  try {
    // 保存側に規則外の名前が混ざっていても返さない（"-x" は guardrailSchemasOf を通らない source でも read しない）
    for (const uri of [
      "schema:///schemas/none",
      "schema:///schemas/a%2Db", // 規則外（% を含む）。a-b に decode して返さない
      "schema:///schemas/a b",
      "schema:///schemas/-x",
      "schema:///schemas/.a",
      "schema:///schemas/a/b",
      "schema:///schemas/a?x=1",
      "schema:///schemas/a#f",
      "schema:///schemas/",
      "schema:///schemas/a/",
      "schema:///schemas//a",
      "schema:///schemas/../a",
      "schema:///schemas/%61",
      "schema:///schemas/a\n",
      "schema://schemas/a",
      "schema:///other/a",
      "file:///schemas/a",
    ]) {
      const r = await rpc(url, auth, "resources/read", { uri });
      assert.equal(r.json!.error?.code, -32002, uri);
      assert.deepEqual(r.json!.error.data, { uri }, uri);
      assert.equal(r.json!.result, undefined, uri);
    }
    // 大文字小文字は別の名前
    assert.equal(JSON.parse((await rpc(url, auth, "resources/read", { uri: "schema:///schemas/A" })).json!.result.contents[0].text).schema, "UP");
    assert.equal(JSON.parse((await rpc(url, auth, "resources/read", { uri: "schema:///schemas/a" })).json!.result.contents[0].text).schema, "A");
  } finally {
    await h.close();
  }
});

test("schema server: 足した・消した定義が center の再起動なしで list / read に反映される（設定 file から読み直す）", async () => {
  const dir = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "schema-src-"));
  const file = join(dir, "center-settings.json");
  const lines: string[] = [];
  const src = schemaSourceFromFile(file, (m) => lines.push(m));
  const h = await startHttpServer({ createServer: () => new McpServer({ name: "x", version: "0" }), schemas: src, port: 0, bind: "127.0.0.1", token: TOKEN, log: () => {} });
  const url = `http://127.0.0.1:${h.port}${SCHEMA_MCP_PATH}`;
  const auth = { authorization: `Bearer ${schemaTokenOf(TOKEN)}` };
  const list = async () => ((await rpc(url, auth, "resources/list")).json!.result.resources as { name: string }[]).map((r) => r.name);
  const read = async (n: string) => (await rpc(url, auth, "resources/read", { uri: `schema:///schemas/${n}` })).json!;
  try {
    assert.deepEqual(await list(), [], "file が無ければ空");
    await writeFile(file, JSON.stringify({ instructions: "x", mcpServers: { secret: { command: "x" } }, guardrailSchemas: { a: def("A1") } }));
    assert.deepEqual(await list(), ["a"]);
    assert.equal(JSON.parse((await read("a")).result.contents[0].text).schema, "A1");
    await writeFile(file, JSON.stringify({ guardrailSchemas: { a: def("A22 longer"), b: def("B", { "t.md": "T" }) } }));
    assert.deepEqual(await list(), ["a", "b"]);
    assert.equal(JSON.parse((await read("a")).result.contents[0].text).schema, "A22 longer");
    await writeFile(file, JSON.stringify({ guardrailSchemas: { b: def("B", { "t.md": "T" }) } }));
    assert.deepEqual(await list(), ["b"]);
    assert.equal((await read("a")).error.code, -32002, "消した定義は返らない");
    // 他の設定（mcpServers など）は応答に出ない
    assert.doesNotMatch(JSON.stringify(await read("b")) + JSON.stringify(await rpc(url, auth, "resources/list")), /secret|command|instructions/);
    // 壊れた file は空（fail closed）。理由の種類だけ log に出る
    await writeFile(file, "{ not json");
    assert.deepEqual(await list(), []);
    assert.ok(lines.some((l) => l.includes(file)));
  } finally {
    await h.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("schema server: 本物の MCP client（SDK）で listResources / readResource ができ、無い名前は -32002 の error になる", async () => {
  const { h, url, auth } = await boot({ s1: def("S1", { "x.md": "X" }) });
  const client = new Client({ name: "t", version: "0" });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: auth } }));
    assert.ok(client.getServerCapabilities()?.resources);
    assert.deepEqual((await client.listResources()).resources.map((r) => r.uri), ["schema:///schemas/s1"]);
    const r = await client.readResource({ uri: "schema:///schemas/s1" });
    assert.equal(r.contents.length, 1);
    assert.deepEqual(JSON.parse((r.contents[0] as { text: string }).text), { name: "s1", schema: "S1", templates: { "x.md": "X" } });
    await assert.rejects(client.readResource({ uri: "schema:///schemas/zz" }), (e: { code?: number; data?: unknown }) => e.code === -32002 && JSON.stringify(e.data) === JSON.stringify({ uri: "schema:///schemas/zz" }));
  } finally {
    await client.close().catch(() => {});
    await h.close();
  }
});

test("discovery: x-schema-discovery の値は JSON 1 本 { type: http, url, headers }。値は ASCII のみで、center の token そのものは入らない", () => {
  const v = schemaDiscoveryValue("http://127.0.0.1:9/mcp/schemas", TOKEN);
  assert.equal(SCHEMA_DISCOVERY_HEADER, "x-schema-discovery");
  const j = JSON.parse(v) as { type: string; url: string; headers: Record<string, string> };
  assert.deepEqual(Object.keys(j).sort(), ["headers", "type", "url"]);
  assert.equal(j.type, "http");
  assert.equal(j.url, "http://127.0.0.1:9/mcp/schemas");
  assert.deepEqual(j.headers, { Authorization: `Bearer ${schemaTokenOf(TOKEN)}` });
  assert.ok(/^[\x20-\x7e]*$/.test(v));
  assert.ok(!v.includes(TOKEN));
  assert.notEqual(schemaTokenOf(TOKEN), schemaTokenOf(TOKEN + "x"));
});

test("discovery の env: http で待ち受けている時だけ置く。host・port は center が組み立てる", () => {
  const env: Record<string, string> = {};
  applySchemaDiscoveryEnv(env, { host: "127.0.0.1", port: null, token: TOKEN });
  applySchemaDiscoveryEnv(env, { host: "127.0.0.1", port: 8123, token: undefined });
  applySchemaDiscoveryEnv(env, { host: "127.0.0.1", port: 8123, token: "" });
  assert.deepEqual(env, {});
  applySchemaDiscoveryEnv(env, { host: "10.0.0.5", port: 8123, token: TOKEN });
  assert.deepEqual(Object.keys(env), [SCHEMA_DISCOVERY_ENV]);
  assert.equal(JSON.parse(env[SCHEMA_DISCOVERY_ENV]!).url, `http://10.0.0.5:8123${SCHEMA_MCP_PATH}`);
});

/** 偽の openspec-mcp: x-schema-discovery の header を読み、そこに書かれた url・headers で schema の MCP server に問い合わせて、読んだ schema を返す。 */
async function fakeOpenspec(): Promise<{ server: HttpServer; url: string; calls: string[] }> {
  const calls: string[] = [];
  const server = createHttpServer((req, res) => {
    const raw = req.headers[SCHEMA_DISCOVERY_HEADER];
    void (async () => {
      if (typeof raw !== "string" || raw === "") {
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ discovery: false }));
        return;
      }
      calls.push(raw);
      const d = JSON.parse(raw) as { type: string; url: string; headers?: Record<string, string> };
      const client = new Client({ name: "fake-openspec", version: "0" });
      try {
        await client.connect(new StreamableHTTPClientTransport(new URL(d.url), { requestInit: { headers: d.headers ?? {} } }));
        const name = new URL(req.url ?? "/", "http://x").searchParams.get("name") ?? "";
        const out = await client.readResource({ uri: `schema:///schemas/${name}` });
        res.writeHead(200, { "content-type": "application/json" }).end((out.contents[0] as { text: string }).text);
      } catch (e) {
        res.writeHead(502, { "content-type": "application/json" }).end(JSON.stringify({ error: String(e) }));
      } finally {
        await client.close().catch(() => {});
      }
    })();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/`, calls };
}

test("つなぎ（偽の openspec-mcp）: mcpServers の 1 件の headers に ${BANTOU_SCHEMA_DISCOVERY} と書くと、session の起動の env と --mcp-config から x-schema-discovery が届き、そこから schema を読める", async () => {
  const center = await boot({ "spec-driven": def("name: spec-driven\n", { "proposal.md": "P" }) });
  const fake = await fakeOpenspec();
  try {
    const { data } = connectionsFromSettings({ mcpServers: { openspec: { type: "http", url: fake.url, headers: { [SCHEMA_DISCOVERY_HEADER]: "${" + SCHEMA_DISCOVERY_ENV + "}", "X-Other": "keep" } } } }, []);
    const mcp = buildSessionMcp(data, { get: () => undefined }, "s1");
    applySchemaDiscoveryEnv(mcp.env, { host: "127.0.0.1", port: center.port, token: TOKEN });
    const entry = mcp.servers.openspec as { url: string; headers: Record<string, string> };
    // --mcp-config には参照のままで、実値（token を含む JSON）は載らない
    assert.equal(entry.headers[SCHEMA_DISCOVERY_HEADER], "${" + SCHEMA_DISCOVERY_ENV + "}");
    assert.ok(!JSON.stringify(mcp.servers).includes(schemaTokenOf(TOKEN)));
    // claude の起動時の展開と同じ（子の env から）
    const sent = Object.fromEntries(Object.entries(entry.headers).map(([k, v]) => [k, expandEnvRefs(v, mcp.env)]));
    assert.equal(sent["X-Other"] !== undefined, true);
    assert.deepEqual(JSON.parse(sent[SCHEMA_DISCOVERY_HEADER]!).url, `http://127.0.0.1:${center.port}${SCHEMA_MCP_PATH}`);
    const r = await fetch(`${entry.url}?name=spec-driven`, { headers: { [SCHEMA_DISCOVERY_HEADER]: sent[SCHEMA_DISCOVERY_HEADER]! } });
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { name: "spec-driven", schema: "name: spec-driven\n", templates: { "proposal.md": "P" } });
    assert.equal(fake.calls.length, 1);
    // header を付けない接続（参照を書かない）は、bantou の側で何も足さない
    const plain = buildSessionMcp(connectionsFromSettings({ mcpServers: { openspec: { type: "http", url: fake.url } } }, []).data, { get: () => undefined }, "s1");
    assert.deepEqual(plain.servers.openspec, { type: "http", url: fake.url });
    const r2 = await fetch(`${fake.url}?name=spec-driven`);
    assert.deepEqual(await r2.json(), { discovery: false });
  } finally {
    await new Promise<void>((r) => fake.server.close(() => r()));
    await center.h.close();
  }
});
