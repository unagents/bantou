import assert from "node:assert/strict";
import { request } from "node:http";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { allowedHostsFor, startHttpServer } from "../src/http.js";
import type { RemoteManager } from "../src/remotes.js";
import { createCenterServer } from "../src/server.js";
import type { SessionManager } from "../src/sessions.js";
import { parseConfig } from "../src/config.js";
import type { RemoteControlSupervisor } from "../src/remote-control.js";
import type { ServerLink } from "../src/server-link.js";

const TOKEN = "test-token-0123456789";
const AUTH = { authorization: `Bearer ${TOKEN}` };

const TOOLS = [
  "cap_kick", "rc_list", "rc_start", "rc_status", "rc_stop", "remote_create", "remote_delete", "remote_list",
  "server_list", "server_status", "session_create", "session_delete", "session_list", "worker_resume",
];

async function boot(
  extra: { sessionIdleTtlMs?: number; sweepIntervalMs?: number; maxSessions?: number; bind?: string; token?: string } = {},
) {
  const config = parseConfig({}, "/tmp/c.json");
  const supervisor = {
    list: () => [],
    shutdown: async () => {},
  } as unknown as RemoteControlSupervisor;
  const link = { list: async () => [] } as unknown as ServerLink;
  const sessions = {} as unknown as SessionManager;
  const remotes = {
    list: (f?: { owner?: string }) => [{ remote_id: "r-1", owner: f?.owner ?? "(all)" }],
    create: async (i: { owner: string }) => ({ remote_id: "r-9", server: "s", serverName: "n", state: "running", owner: i.owner }),
  } as unknown as RemoteManager;
  const h = await startHttpServer({
    createServer: () => createCenterServer({ config, supervisor, link, sessions, remotes }),
    port: 0,
    log: () => {},
    ...extra,
    bind: extra.bind ?? "127.0.0.1",
    token: extra.token ?? TOKEN,
  });
  return { h, url: new URL(`http://127.0.0.1:${h.port}/mcp`) };
}

test("http: 2 クライアントが並行に接続して tools/list と tool 呼び出しができる", async () => {
  const { h, url } = await boot();
  const clients = [new Client({ name: "a", version: "0" }), new Client({ name: "b", version: "0" })];
  try {
    await Promise.all(clients.map((c) => c.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: AUTH } }))));
    const lists = await Promise.all(clients.map((c) => c.listTools()));
    for (const l of lists) assert.deepEqual(l.tools.map((t) => t.name).sort(), TOOLS);
    const r = await Promise.all(clients.map((c) => c.callTool({ name: "rc_list", arguments: {} })));
    for (const x of r) assert.deepEqual((x.content as { text: string }[])[0].text, "[]");
    // 片方を閉じても他方は使える
    await clients[0].close();
    assert.equal((await clients[1].listTools()).tools.length, TOOLS.length);
  } finally {
    await Promise.all(clients.map((c) => c.close().catch(() => {})));
    await h.close();
  }
});

test("http: /mcp 以外は 404、session 無しの非 initialize は 400、未知 session は 404", async () => {
  const { h } = await boot();
  const base = `http://127.0.0.1:${h.port}`;
  try {
    assert.equal((await fetch(`${base}/other`)).status, 404);
    const post = (headers: Record<string, string>) =>
      fetch(`${base}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...AUTH, ...headers },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      });
    assert.equal((await post({})).status, 400);
    assert.equal((await post({ "mcp-session-id": "nope" })).status, 404);
    assert.equal((await fetch(`${base}/mcp`, { headers: AUTH })).status, 400);
  } finally {
    await h.close();
  }
});

const INIT = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "0" } },
};
const MCP_HEADERS = { "content-type": "application/json", accept: "application/json, text/event-stream", ...AUTH };

/** Host を差し替えて POST する（fetch は Host を上書きできない）。 */
function rawPost(port: number, headers: Record<string, string>, body: string): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path: "/mcp", method: "POST", headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

test("http: 外部 Host / Origin は 403、正規の Host（localhost 含む）は通る", async () => {
  const { h } = await boot();
  const body = JSON.stringify(INIT);
  try {
    assert.equal((await rawPost(h.port, { ...MCP_HEADERS, host: "evil.example.com" }, body)).status, 403);
    assert.equal((await rawPost(h.port, { ...MCP_HEADERS, host: "127.0.0.1" }, body)).status, 403, "ポート無しは不可");
    assert.equal((await rawPost(h.port, { ...MCP_HEADERS, host: `127.0.0.1:${h.port}`, origin: "http://evil.example.com" }, body)).status, 403);
    assert.equal((await rawPost(h.port, { ...MCP_HEADERS, host: `127.0.0.1:${h.port}` }, body)).status, 200);
    assert.equal((await rawPost(h.port, { ...MCP_HEADERS, host: `localhost:${h.port}`, origin: `http://localhost:${h.port}` }, body)).status, 200);
  } finally {
    await h.close();
  }
});

test("http: 放置 session は TTL で閉じられ、以降は 404（開いた SSE がある間は保持）", async () => {
  const { h, url } = await boot({ sessionIdleTtlMs: 80, sweepIntervalMs: 20 });
  const post = (sid: string) =>
    fetch(url, {
      method: "POST",
      headers: { ...MCP_HEADERS, "mcp-session-id": sid },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
    });
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  try {
    const init = async () => {
      const r = await fetch(url, { method: "POST", headers: MCP_HEADERS, body: JSON.stringify(INIT) });
      await r.body?.cancel();
      return r.headers.get("mcp-session-id") as string;
    };
    const idle = await init();
    const live = await init();
    // live は GET の SSE を開きっぱなしにする
    const ac = new AbortController();
    const sse = await fetch(url, { headers: { accept: "text/event-stream", ...AUTH, "mcp-session-id": live }, signal: ac.signal });
    assert.equal(sse.status, 200);
    await wait(300);
    const r1 = await post(idle);
    assert.equal(r1.status, 404);
    await r1.body?.cancel();
    const r2 = await post(live);
    assert.notEqual(r2.status, 404);
    await r2.body?.cancel();
    ac.abort();
  } finally {
    await h.close();
  }
});

test("http: session 上限を超える initialize は 503、閉じれば再び受け付ける", async () => {
  const { h, url } = await boot({ maxSessions: 1 });
  const init = () => fetch(url, { method: "POST", headers: MCP_HEADERS, body: JSON.stringify(INIT) });
  try {
    const first = await init();
    assert.equal(first.status, 200);
    const sid = first.headers.get("mcp-session-id") as string;
    await first.body?.cancel();
    const second = await init();
    assert.equal(second.status, 503);
    await second.body?.cancel();
    const del = await fetch(url, { method: "DELETE", headers: { ...AUTH, "mcp-session-id": sid } });
    await del.body?.cancel();
    const third = await init();
    assert.equal(third.status, 200);
    await third.body?.cancel();
  } finally {
    await h.close();
  }
});

test("http: 上限超過のボディは 413（応答してから切断）", async () => {
  const { h } = await boot();
  try {
    const big = JSON.stringify({ ...INIT, pad: "x".repeat(5 * 1024 * 1024) });
    const r = await rawPost(h.port, { ...MCP_HEADERS, host: `127.0.0.1:${h.port}`, "content-length": String(Buffer.byteLength(big)) }, big);
    assert.equal(r.status, 413);
    // Content-Length 無し（chunked）でも 413
    const chunked = await new Promise<number>((resolve, reject) => {
      const req = request(
        { host: "127.0.0.1", port: h.port, path: "/mcp", method: "POST", headers: { ...MCP_HEADERS, "transfer-encoding": "chunked" } },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on("error", reject);
      req.write(big);
      req.end();
    });
    assert.equal(chunked, 413);
  } finally {
    await h.close();
  }
});

test("http: Bearer が一致すれば 200、不一致・欠落・形式違いは 401（WWW-Authenticate 付き）", async () => {
  const { h, url } = await boot();
  const body = JSON.stringify(INIT);
  const post = (authorization?: string) =>
    fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(authorization ? { authorization } : {}) },
      body,
    });
  try {
    assert.equal((await post(`Bearer ${TOKEN}`)).status, 200);
    for (const bad of [undefined, "Bearer wrong-token-0123456789", `Bearer ${TOKEN}x`, `Bearer ${TOKEN.slice(1)}`, TOKEN, `Basic ${TOKEN}`, "Bearer "]) {
      const r = await post(bad);
      assert.equal(r.status, 401, `authorization=${bad}`);
      assert.equal(r.headers.get("www-authenticate"), "Bearer");
    }
    // session 付き・GET・DELETE も token が無ければ 401（session の有無を先に教えない）
    for (const method of ["GET", "DELETE"]) {
      assert.equal((await fetch(url, { method, headers: { "mcp-session-id": "nope" } })).status, 401);
    }
    assert.equal((await fetch(url, { method: "GET", headers: { ...AUTH, "mcp-session-id": "nope" } })).status, 404);
  } finally {
    await h.close();
  }
});

test("http: token が短い・空なら起動しない", async () => {
  for (const token of ["", "short"]) {
    await assert.rejects(
      startHttpServer({ createServer: () => { throw new Error("unused"); }, port: 0, bind: "127.0.0.1", token, log: () => {} }),
      /token は 12 文字以上/,
    );
  }
});

test("allowedHostsFor: loopback bind は loopback 名のみ、それ以外の bind は Host 検査なし（null）", () => {
  assert.deepEqual(allowedHostsFor("127.0.0.1", 7910)?.hosts, ["127.0.0.1:7910", "localhost:7910", "[::1]:7910"]);
  assert.deepEqual(allowedHostsFor("localhost", 7910)?.hosts, ["127.0.0.1:7910", "localhost:7910", "[::1]:7910"]);
  assert.equal(allowedHostsFor("0.0.0.0", 7910), null);
  assert.equal(allowedHostsFor("::", 7910), null);
  assert.equal(allowedHostsFor("192.168.1.5", 7910), null);
});

test("http: wildcard bind では別ホスト名宛ての Host / Origin も token があれば通り、無ければ 401", async () => {
  const { h } = await boot({ bind: "0.0.0.0" });
  const body = JSON.stringify(INIT);
  const lan = { host: `192.168.1.50:${h.port}`, origin: `http://192.168.1.50:${h.port}` };
  try {
    assert.equal((await rawPost(h.port, { ...MCP_HEADERS, ...lan }, body)).status, 200);
    assert.equal((await rawPost(h.port, { ...MCP_HEADERS, host: `mac200:${h.port}` }, body)).status, 200);
    const { authorization: _a, ...noAuth } = MCP_HEADERS;
    assert.equal((await rawPost(h.port, { ...noAuth, ...lan }, body)).status, 401);
    assert.equal((await rawPost(h.port, { ...MCP_HEADERS, ...lan, authorization: "Bearer nope-nope-nope-nope" }, body)).status, 401);
  } finally {
    await h.close();
  }
});

test("http: owner は header X-Bantou-Session > URL query session > 引数 owner の順で解決される", async () => {
  const { h, url } = await boot();
  const connect = async (u: URL, headers: Record<string, string> = {}) => {
    const c = new Client({ name: "o", version: "0" });
    await c.connect(new StreamableHTTPClientTransport(u, { requestInit: { headers: { ...AUTH, ...headers } } }));
    return c;
  };
  const owner = async (c: Client, args: Record<string, unknown> = {}): Promise<string> => {
    const r = await c.callTool({ name: "remote_list", arguments: args });
    return (JSON.parse((r.content as { text: string }[])[0].text) as { owner: string }[])[0].owner;
  };
  const clients: Client[] = [];
  try {
    const hdr = await connect(url, { "X-Bantou-Session": "pm-h" });
    const q = new URL(url);
    q.searchParams.set("session", "pm-q");
    const qry = await connect(q);
    const both = await connect(q, { "X-Bantou-Session": "pm-h" });
    const none = await connect(url);
    clients.push(hdr, qry, both, none);
    assert.equal(await owner(hdr), "pm-h");
    assert.equal(await owner(hdr, { owner: "arg" }), "pm-h"); // header が引数より優先
    assert.equal(await owner(qry), "pm-q");
    assert.equal(await owner(both), "pm-h"); // header が query より優先
    assert.equal(await owner(none, { owner: "arg" }), "arg");
    assert.equal(await owner(none), "(all)"); // 分からなければ全件
    // create は owner 必須（header / query / 引数のどれか）
    const noOwner = await none.callTool({ name: "remote_create", arguments: { prompt: "p" } });
    assert.equal(noOwner.isError, true);
    const viaHdr = await hdr.callTool({ name: "remote_create", arguments: { prompt: "p" } });
    assert.equal((JSON.parse((viaHdr.content as { text: string }[])[0].text) as { state: string }).state, "running");
  } finally {
    await Promise.all(clients.map((c) => c.close().catch(() => {})));
    await h.close();
  }
});
