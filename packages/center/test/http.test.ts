import assert from "node:assert/strict";
import { request } from "node:http";
import { test } from "node:test";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { allowedHostsFor, startHttpServer } from "../src/http.js";
import type { RemoteManager } from "../src/remotes.js";
import { createCenterServer, createSessionMcpServer } from "../src/server.js";
import { createCore, type Core } from "../src/core.js";
import { createEventHub } from "../src/events.js";
import { createSessionTokens, type SessionTokens } from "../src/session-auth.js";
import type { SessionManager } from "../src/sessions.js";
import { parseConfig } from "../src/config.js";
import type { RemoteControlSupervisor } from "../src/remote-control.js";
import type { ServerLink } from "../src/server-link.js";

const TOKEN = "test-token-0123456789";
const AUTH = { authorization: `Bearer ${TOKEN}` };

const AUTH_WITH = (name: string): Record<string, string> => ({ ...AUTH, "x-bantou-session": name });

const TOOLS = [
  "center_info", "center_settings_get", "center_settings_update", "rc_list", "rc_start", "rc_status", "rc_stop", "remote_list", "remote_wait",
  "server_list", "server_peers", "server_status", "session_create", "session_delete", "session_list", "session_login", "session_login_code", "session_settings_get", "session_settings_update", "session_update", "worker_reply", "worker_resume",
];

async function boot(
  extra: { sessionIdleTtlMs?: number; sweepIntervalMs?: number; maxSessions?: number; bind?: string; token?: string; keepAliveMs?: number; workspace?: string; log?: (msg: string) => void; onStatusLine?: (name: string, payload: unknown) => void; onHook?: (name: string, payload: unknown) => void } = {},
) {
  const config = parseConfig({}, "/tmp/c.json");
  const supervisor = {
    list: () => [],
    shutdown: async () => {},
  } as unknown as RemoteControlSupervisor;
  const link = { list: async () => [] } as unknown as ServerLink;
  const sessions = {} as unknown as SessionManager;
  const remotes = {
    list: (f?: { owner?: string }) => [{ remote_id: "c-1", owner: f?.owner ?? "(all)" }],
    send: async (i: { owner: string }) => ({ remote_id: "c-9", server: "s", serverName: "n", state: "running", owner: i.owner }),
  } as unknown as RemoteManager;
  const tokens = createSessionTokens();
  const core = createCore();
  const events = createEventHub();
  const created: unknown[] = [];
  const remotes2 = {
    ...remotes,
    send: async (i: { owner: string }) => (created.push(i), { remote_id: "c-9", server: "s", serverName: "n", state: "running", owner: i.owner }),
  } as unknown as RemoteManager;
  const h = await startHttpServer({
    createServer: () => createCenterServer({ config, supervisor, link, sessions, remotes }),
    createSessionServer: (owner) => createSessionMcpServer({ remotes: remotes2, owner }),
    sessionAuth: tokens,
    core,
    events,
    port: 0,
    log: () => {},
    ...extra,
    bind: extra.bind ?? "127.0.0.1",
    token: extra.token ?? TOKEN,
  });
  return { h, url: new URL(`http://127.0.0.1:${h.port}/mcp`), tokens, core, events, created, base: `http://127.0.0.1:${h.port}` };
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

test("http: 2xx 以外の応答は method・path・status・理由で log に残り、2xx は残らない", async () => {
  const lines: string[] = [];
  const { h } = await boot({ log: (m) => lines.push(m) });
  const base = `http://127.0.0.1:${h.port}`;
  try {
    assert.equal((await fetch(`${base}/other?x=1`)).status, 404);
    assert.equal((await fetch(`${base}/mcp`)).status, 401);
    assert.equal((await fetch(`${base}/mcp`, { headers: { ...AUTH, "mcp-session-id": "nope" } })).status, 404);
    assert.equal((await fetch(`${base}/mcp`, { method: "POST", headers: MCP_HEADERS, body: JSON.stringify(INIT) })).status, 200);
    const http = lines.filter((l) => l.startsWith("HTTP "));
    assert.deepEqual(http, [
      "HTTP GET /other -> 404: not found (from 127.0.0.1)",
      "HTTP GET /mcp -> 401: unauthorized (from 127.0.0.1)",
      "HTTP GET /mcp -> 404: session が存在しない (from 127.0.0.1)",
    ]);
  } finally {
    await h.close();
  }
});

test("http: 重複スラッシュ・末尾スラッシュの path も /mcp・/mcp/session・/events・/sessions/.. として通る", async () => {
  const lines: string[] = [];
  const { h, base } = await boot({ log: (m) => lines.push(m) });
  try {
    for (const p of ["/mcp", "//mcp", "/mcp/", "///mcp//", "//mcp?x=1"]) {
      const r = await fetch(`${base}${p}`, { method: "POST", headers: MCP_HEADERS, body: JSON.stringify(INIT) });
      assert.equal(r.status, 200, p);
    }
    assert.equal((await fetch(`${base}//mcp`)).status, 401, "認証は // でも必要");
    assert.equal((await fetch(`${base}//mcp/session/`, { method: "POST" })).status, 401, "/mcp/session 側も // で照合される");
    assert.equal((await fetch(`${base}//sessions//nope/output/`, { headers: AUTH })).status, 404);
    assert.equal((await fetch(`${base}/mcpx`)).status, 404, "別の path は通さない");
    assert.equal((await fetch(`${base}//`)).status, 404);
    assert.ok(lines.some((l) => l === "HTTP GET //mcp -> 401: unauthorized (from 127.0.0.1)"), "log には受けた path のまま残る");
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
    // 作成は外向けから消えた（session 向けの窓口だけ）
    await assert.rejects(async () => {
      const r = await hdr.callTool({ name: "remote_create", arguments: { prompt: "p" } });
      if (r.isError) throw new Error("tool error");
    });
  } finally {
    await Promise.all(clients.map((c) => c.close().catch(() => {})));
    await h.close();
  }
});

// -- 窓口の分離と認証 --

const postInit = (url: string, headers: Record<string, string>) =>
  fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
    body: JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "0" } },
    }),
  });

const sessionClient = async (base: string, token: string, name: string) => {
  const c = new Client({ name: "s", version: "0" });
  await c.connect(
    new StreamableHTTPClientTransport(new URL(`${base}/mcp/session`), {
      requestInit: { headers: { authorization: `Bearer ${token}`, "X-Bantou-Session": name } },
    }),
  );
  return c;
};

test("/mcp/session: 窓口は remote_send / remote_create / remote_delete / remote_list / remote_wait / worker_reply だけ。owner は header の session 名", async () => {
  const { h, tokens, created, base } = await boot();
  const t = tokens.issue("pm1");
  const c = await sessionClient(base, t, "pm1");
  try {
    assert.deepEqual((await c.listTools()).tools.map((x) => x.name).sort(), ["remote_create", "remote_delete", "remote_list", "remote_send", "remote_wait", "worker_reply"]);
    await c.callTool({ name: "remote_create", arguments: { goal: "p", owner: "evil" } });
    assert.deepEqual(created, [{ owner: "pm1", goal: "p" }]);
    const l = await c.callTool({ name: "remote_list", arguments: {} });
    assert.equal((JSON.parse((l.content as { text: string }[])[0].text) as { owner: string }[])[0].owner, "pm1");
  } finally {
    await c.close().catch(() => {});
    await h.close();
  }
});

test("/mcp/session: session A の token に header B は 401、外向け token・token 無し・header 無し・不正 token も 401", async () => {
  const { h, tokens, base } = await boot();
  const ta = tokens.issue("a");
  tokens.issue("b");
  const url = `${base}/mcp/session`;
  try {
    assert.equal((await postInit(url, { authorization: `Bearer ${ta}`, "x-bantou-session": "b" })).status, 401);
    assert.equal((await postInit(url, AUTH_WITH("a"))).status, 401); // 外向け token
    assert.equal((await postInit(url, { "x-bantou-session": "a" })).status, 401);
    assert.equal((await postInit(url, { authorization: `Bearer ${ta}` })).status, 401);
    assert.equal((await postInit(url, { authorization: "Bearer wrong", "x-bantou-session": "a" })).status, 401);
    assert.equal((await postInit(url, { authorization: `Bearer ${ta}`, "x-bantou-session": "a b" })).status, 401);
    assert.equal((await postInit(url, { authorization: `Bearer ${ta}`, "x-bantou-session": "a" })).status, 200);
    // 発行し直すと古い token は使えない / revoke 後も 401
    const ta2 = tokens.issue("a");
    assert.equal((await postInit(url, { authorization: `Bearer ${ta}`, "x-bantou-session": "a" })).status, 401);
    tokens.revoke("a");
    assert.equal((await postInit(url, { authorization: `Bearer ${ta2}`, "x-bantou-session": "a" })).status, 401);
  } finally {
    await h.close();
  }
});


test("session token は外向け /mcp では通らない。MCP session id は窓口をまたいで使えない", async () => {
  const { h, tokens, base } = await boot();
  const ta = tokens.issue("a");
  try {
    assert.equal((await postInit(`${base}/mcp`, { authorization: `Bearer ${ta}`, "x-bantou-session": "a" })).status, 401);
    // 外向けで作った MCP session id を /mcp/session に持ち込む
    const ext = await postInit(`${base}/mcp`, AUTH);
    const sid = ext.headers.get("mcp-session-id");
    assert.ok(sid);
    const r = await fetch(`${base}/mcp/session`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${ta}`, "x-bantou-session": "a", "mcp-session-id": sid },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
    });
    assert.equal(r.status, 404);
    // session A の MCP session id を、別 session B の認証で使えない
    const tb = tokens.issue("b");
    const a = await postInit(`${base}/mcp/session`, { authorization: `Bearer ${ta}`, "x-bantou-session": "a" });
    const asid = a.headers.get("mcp-session-id")!;
    const r2 = await fetch(`${base}/mcp/session`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${tb}`, "x-bantou-session": "b", "mcp-session-id": asid },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
    });
    assert.equal(r2.status, 404);
  } finally {
    await h.close();
  }
});

// -- core の HTTP（SSE / input / resize） --

/** SSE を読み、イベントを集める。条件を満たすまで待つ。 */
async function readSse(res: Response, until: (evs: { id?: string; event?: string; data: string }[]) => boolean, ms = 3000) {
  const evs: { id?: string; event?: string; data: string }[] = [];
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  const end = Date.now() + ms;
  while (!until(evs) && Date.now() < end) {
    const r = await Promise.race([reader.read(), new Promise<null>((r2) => setTimeout(() => r2(null), 100))]);
    if (r === null) continue;
    if (r.done) break;
    buf += dec.decode(r.value, { stream: true });
    const parts = buf.split("\n\n");
    buf = parts.pop() ?? "";
    for (const p of parts) {
      const ev: { id?: string; event?: string; data: string } = { data: "" };
      for (const line of p.split("\n")) {
        if (line.startsWith("id: ")) ev.id = line.slice(4);
        else if (line.startsWith("event: ")) ev.event = line.slice(7);
        else if (line.startsWith("data: ")) ev.data = line.slice(6);
        else if (line.startsWith(": ")) ev.event = "comment:" + line.slice(2);
      }
      evs.push(ev);
    }
  }
  await reader.cancel().catch(() => {});
  return evs;
}
const b64 = (s: string): string => Buffer.from(s).toString("base64");

test("core SSE: 外向け token 必須。未知 session は 404。after 無しは reset の後に全部、live も流れる", async () => {
  const { h, core, base } = await boot();
  core.register("s1");
  core.push("s1", Buffer.from("one"));
  core.push("s1", Buffer.from("two"));
  try {
    assert.equal((await fetch(`${base}/sessions/s1/output`)).status, 401);
    assert.equal((await fetch(`${base}/sessions/s1/output`, { headers: { authorization: "Bearer nope" } })).status, 401);
    assert.equal((await fetch(`${base}/sessions/nope/output`, { headers: AUTH })).status, 404);
    const res = await fetch(`${base}/sessions/s1/output`, { headers: AUTH });
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /text\/event-stream/);
    setTimeout(() => core.push("s1", Buffer.from("live")), 50);
    const evs = await readSse(res, (e) => e.length >= 4);
    assert.deepEqual(evs.map((e) => e.event), ["reset", "output", "output", "output"]);
    assert.deepEqual(evs.slice(1).map((e) => [e.id, e.data]), [["1", b64("one")], ["2", b64("two")], ["3", b64("live")]]);
  } finally {
    await h.close();
  }
});

test("core SSE: Last-Event-ID / ?after で続きから。残っていなければ reset。header が query より優先", async () => {
  const { h, core, base } = await boot();
  core.register("s1");
  for (const w of ["a", "b", "c"]) core.push("s1", Buffer.from(w));
  try {
    const get = (path: string, headers: Record<string, string> = {}) => fetch(`${base}${path}`, { headers: { ...AUTH, ...headers } });
    let evs = await readSse(await get("/sessions/s1/output", { "last-event-id": "1" }), (e) => e.length >= 2);
    assert.deepEqual(evs.map((e) => [e.event, e.id]), [["output", "2"], ["output", "3"]]);
    evs = await readSse(await get("/sessions/s1/output?after=2"), (e) => e.length >= 1);
    assert.deepEqual(evs.map((e) => [e.event, e.id]), [["output", "3"]]);
    evs = await readSse(await get("/sessions/s1/output?after=1", { "last-event-id": "3" }), () => false, 300);
    assert.deepEqual(evs, []); // 3 まで受け取り済み
    evs = await readSse(await get("/sessions/s1/output?after=junk"), (e) => e.length >= 4);
    assert.equal(evs[0].event, "reset");
  } finally {
    await h.close();
  }
});

test("core SSE: 古すぎる after（キューから落ちた分）は reset + 残っている分。keep-alive コメントが流れる", async () => {
  const { h, core, base } = await boot({ keepAliveMs: 40 });
  // 上限 8 MiB の core とは別に、小さい上限の core を差し替える代わりに、実際に溢れさせる
  core.register("s1");
  const big = Buffer.alloc(3 * 1024 * 1024, 1);
  for (let i = 0; i < 4; i++) core.push("s1", big); // 12 MiB 分 → id 1,2 は落ちる
  try {
    const evs = await readSse(await fetch(`${base}/sessions/s1/output?after=1`, { headers: AUTH }), (e) => e.some((x) => x.event === "comment:ka"));
    assert.equal(evs[0].event, "reset");
    assert.deepEqual(evs.filter((e) => e.event === "output").map((e) => e.id), ["3", "4"]);
    assert.ok(evs.some((e) => e.event === "comment:ka"));
  } finally {
    await h.close();
  }
});

test("core POST: input は 204 / 実行中でなければ 409 / 未知 session 404 / 不正は 400。resize も同様", async () => {
  const { h, core, base } = await boot();
  core.register("s1");
  const got: string[] = [];
  const post = (path: string, body: unknown, headers: Record<string, string> = AUTH) =>
    fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  try {
    assert.equal((await post("/sessions/s1/input", { data: b64("x") })).status, 409);
    assert.equal((await post("/sessions/s1/resize", { cols: 80, rows: 24 })).status, 409);
    core.attach("s1", { input: (d) => got.push(`in:${d.toString()}`), resize: (c, r) => got.push(`rs:${c}x${r}`) });
    assert.equal((await post("/sessions/s1/input", { data: b64("hi\r") })).status, 204);
    assert.equal((await post("/sessions/s1/resize", { cols: 100, rows: 30 })).status, 204);
    assert.equal((await post("/sessions/s1/resize", { cols: 90, rows: 20 })).status, 204);
    assert.deepEqual(got, ["in:hi\r", "rs:100x30", "rs:90x20"]);
    assert.deepEqual(core.size("s1"), { cols: 90, rows: 20 }); // 最後に送った側が勝つ
    assert.equal((await post("/sessions/nope/input", { data: "" })).status, 404);
    assert.equal((await post("/sessions/s1/input", { data: 5 })).status, 400);
    assert.equal((await post("/sessions/s1/input", { data: "***" })).status, 400);
    assert.equal((await post("/sessions/s1/resize", { cols: 0, rows: 5 })).status, 400);
    assert.equal((await post("/sessions/s1/resize", { cols: "a", rows: 5 })).status, 400);
    assert.equal((await post("/sessions/s1/input", { data: b64("x") }, {})).status, 401);
    assert.equal((await fetch(`${base}/sessions/s1/input`, { headers: AUTH })).status, 405);
    assert.equal((await fetch(`${base}/sessions/s1/output`, { method: "POST", headers: AUTH })).status, 405);
  } finally {
    await h.close();
  }
});

// -- GET /events --

test("GET /events: token 必須。接続時に空の sessions イベント、増減で理由と名前付きのイベント、keep-alive", async () => {
  const { h, events, base } = await boot({ keepAliveMs: 40 });
  try {
    assert.equal((await fetch(`${base}/events`)).status, 401);
    assert.equal((await fetch(`${base}/events`, { headers: { authorization: "Bearer nope" } })).status, 401);
    assert.equal((await fetch(`${base}/events`, { method: "POST", headers: AUTH })).status, 405);
    const res = await fetch(`${base}/events`, { headers: AUTH });
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /text\/event-stream/);
    setTimeout(() => {
      events.publish({ reason: "created", name: "a" });
      events.publish({ reason: "deleted", name: "a" });
      events.publish({ reason: "restored", name: "b" });
    }, 20);
    const evs = await readSse(res, (e) => e.filter((x) => x.event === "sessions").length >= 4 && e.some((x) => x.event === "comment:ka"));
    const sess = evs.filter((e) => e.event === "sessions");
    assert.deepEqual(sess.map((e) => e.data), [
      "{}",
      '{"reason":"created","name":"a"}',
      '{"reason":"deleted","name":"a"}',
      '{"reason":"restored","name":"b"}',
    ]);
    assert.ok(sess.every((e) => e.id === undefined)); // event ID は付けない
    assert.ok(evs.some((e) => e.event === "comment:ka"));
  } finally {
    await h.close();
  }
});

test("GET /events: 切断後は購読が外れ、events を渡さなければ 404", async () => {
  const { h, events, base } = await boot();
  try {
    const res = await fetch(`${base}/events`, { headers: AUTH });
    await readSse(res, (e) => e.length >= 1);
    await new Promise((r) => setTimeout(r, 50));
    events.publish({ reason: "created", name: "x" }); // 購読者が居なくても投げない
  } finally {
    await h.close();
  }
  const bare = await startHttpServer({ createServer: () => { throw new Error("unused"); }, port: 0, bind: "127.0.0.1", token: TOKEN, log: () => {} });
  try {
    assert.equal((await fetch(`http://127.0.0.1:${bare.port}/events`, { headers: AUTH })).status, 404);
  } finally {
    await bare.close();
  }
});

// -- 添付画像 --

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("png-body")]);
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from("jpg-body")]);

async function bootAttach(log: (m: string) => void = () => {}) {
  const ws = await mkdtemp(join(tmpdir(), "bantou-att-"));
  const b = await boot({ workspace: ws, log });
  b.core.register("s1");
  const post = (name: string, body: Buffer | string, type: string | null, auth: Record<string, string> = AUTH) =>
    fetch(`${b.base}/sessions/${name}/attachments`, {
      method: "POST",
      headers: { ...auth, ...(type ? { "content-type": type } : {}) },
      body: body as BodyInit,
    });
  return { ...b, ws, post, done: async () => { await b.h.close(); await rm(ws, { recursive: true, force: true }); } };
}

test("添付: 保存して {path,bytes,type} を返し、連番が進み、型ごとの拡張子になる。log に本文を残さない", async () => {
  const logs: string[] = [];
  const t = await bootAttach((m) => logs.push(m));
  try {
    const r1 = await t.post("s1", PNG, "image/png");
    assert.equal(r1.status, 201);
    const j1 = (await r1.json()) as { path: string; bytes: number; type: string };
    assert.equal(j1.bytes, PNG.length);
    assert.equal(j1.type, "image/png");
    assert.match(j1.path, new RegExp(`^${t.ws.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/s1/attachments/\\d{8}-\\d{6}-\\d{2}\\.png$`));
    assert.deepEqual(await readFile(j1.path), PNG);
    const r2 = await t.post("s1", JPG, "image/jpeg; charset=x");
    const j2 = (await r2.json()) as { path: string };
    assert.match(j2.path, /-\d{2}\.jpg$/);
    // 同じ秒に連続で 5 枚: 連番は全部違う
    const paths = new Set<string>();
    for (let i = 0; i < 5; i++) paths.add(((await (await t.post("s1", PNG, "image/png")).json()) as { path: string }).path);
    assert.equal(paths.size, 5);
    assert.equal((await readdir(join(t.ws, "s1", "attachments"))).length, 7);
    assert.ok(logs.some((l) => l.includes("添付を保存") && l.includes("session=s1") && l.includes(`bytes=${PNG.length}`) && l.includes(j1.path)));
    assert.ok(!logs.some((l) => l.includes("png-body")));
  } finally {
    await t.done();
  }
});

test("添付: 連番は同秒で 01 から振る（時刻固定）", async () => {
  const { saveAttachment } = await import("../src/attachments.js");
  const ws = await mkdtemp(join(tmpdir(), "bantou-att-"));
  try {
    const now = new Date(2026, 10, 4, 2, 45, 7);
    const a = await saveAttachment({ workspace: ws, session: "x", type: "image/gif", body: Buffer.from("GIF89a-"), now });
    const b = await saveAttachment({ workspace: ws, session: "x", type: "image/gif", body: Buffer.from("GIF89a-"), now });
    assert.equal(a.path, join(ws, "x", "attachments", "20261104-024507-01.gif"));
    assert.equal(b.path, join(ws, "x", "attachments", "20261104-024507-02.gif"));
  } finally {
    await rm(ws, { recursive: true, force: true });
  }
});

test("添付: 型違い・中身が画像でない・空・サイズ超過・未知 session・不正 session 名・method を拒否し、拒否理由を log に残す", async () => {
  const logs: string[] = [];
  const t = await bootAttach((m) => logs.push(m));
  try {
    assert.equal((await t.post("s1", "hello", "text/plain")).status, 415);
    assert.equal((await t.post("s1", PNG, null)).status, 415);
    assert.equal((await t.post("s1", PNG, "image/svg+xml")).status, 415);
    assert.equal((await t.post("s1", JPG, "image/png")).status, 415); // 宣言と中身が違う
    assert.equal((await t.post("s1", Buffer.alloc(0), "image/png")).status, 400);
    const big = Buffer.concat([PNG, Buffer.alloc(20 * 1024 * 1024 - PNG.length + 1)]);
    assert.equal((await t.post("s1", big, "image/png")).status, 413);
    const exact = Buffer.concat([PNG, Buffer.alloc(20 * 1024 * 1024 - PNG.length)]);
    assert.equal((await t.post("s1", exact, "image/png")).status, 201);
    assert.equal((await t.post("nope", PNG, "image/png")).status, 404);
    assert.equal((await t.post("..%2Fx", PNG, "image/png")).status, 404);
    assert.equal((await fetch(`${t.base}/sessions/s1/attachments`, { headers: AUTH })).status, 405);
    assert.ok(logs.some((l) => l.includes("添付を拒否") && l.includes("session=s1") && l.includes("未対応の型")));
    assert.ok(logs.some((l) => l.includes("添付を拒否") && l.includes("MB")));
    // 拒否したものは 20MB ちょうど 1 枚以外ディスクに無い
    assert.equal((await readdir(join(t.ws, "s1", "attachments"))).length, 1);
    assert.deepEqual(await readdir(t.ws), ["s1"]);
  } finally {
    await t.done();
  }
});

test("添付: 認証なし・違う token は 401 で何も書かない。workspace 未設定は 409", async () => {
  const t = await bootAttach();
  try {
    assert.equal((await t.post("s1", PNG, "image/png", {})).status, 401);
    assert.equal((await t.post("s1", PNG, "image/png", { authorization: "Bearer nope" })).status, 401);
    assert.deepEqual(await readdir(t.ws), []);
  } finally {
    await t.done();
  }
  const b = await boot();
  b.core.register("s1");
  try {
    const r = await fetch(`${b.base}/sessions/s1/attachments`, { method: "POST", headers: { ...AUTH, "content-type": "image/png" }, body: PNG });
    assert.equal(r.status, 409);
  } finally {
    await b.h.close();
  }
});

test("POST /sessions/<name>/status-line: session token で JSON を受け取り 204。A の token で B・外向け token・token 無し・不正 token は 401、onStatusLine に渡らない", async () => {
  const got: { name: string; payload: unknown }[] = [];
  const { h, base, tokens } = await boot({ onStatusLine: (name, payload) => got.push({ name, payload }) });
  try {
    const ta = tokens.issue("a");
    tokens.issue("b");
    const url = (n: string): string => `${base}/sessions/${n}/status-line`;
    const post = (n: string, headers: Record<string, string>, body: string) =>
      fetch(url(n), { method: "POST", headers: { "content-type": "application/json", ...headers }, body });
    const body = JSON.stringify({ context_window: { context_window_size: 1000000, used_percentage: 6 } });
    const ok = await post("a", { authorization: `Bearer ${ta}` }, body);
    assert.equal(ok.status, 204);
    assert.deepEqual(got, [{ name: "a", payload: JSON.parse(body) }]);
    for (const headers of [{ authorization: `Bearer ${ta}` }, AUTH, {}, { authorization: "Bearer nope" }]) {
      const r = await post("b", headers, body);
      assert.equal(r.status, 401);
    }
    assert.equal((await post("zzz", { authorization: `Bearer ${ta}` }, body)).status, 401, "token の無い session 名");
    assert.equal(got.length, 1, "401 は反映しない");
    assert.equal((await fetch(url("a"), { method: "GET", headers: { authorization: `Bearer ${ta}` } })).status, 405);
  } finally {
    await h.close();
  }
});

test("POST /sessions/<name>/status-line: 壊れた JSON は 400 でログに残し反映しない。object 以外も 400", async () => {
  const got: unknown[] = [];
  const lines: string[] = [];
  const { h, base, tokens } = await boot({ onStatusLine: (_n, p) => got.push(p), log: (m) => lines.push(m) });
  try {
    const t = tokens.issue("a");
    const post = (body: string) =>
      fetch(`${base}/sessions/a/status-line`, { method: "POST", headers: { authorization: `Bearer ${t}`, "content-type": "application/json" }, body });
    assert.equal((await post('{"context_window":')).status, 400);
    assert.ok(lines.some((l) => l.includes("statusLine の JSON が不正") && l.includes("session=a")), lines.join("\n"));
    assert.ok(lines.some((l) => l.includes("HTTP POST /sessions/a/status-line -> 400")));
    assert.equal((await post("[1]")).status, 400);
    assert.equal((await post('"x"')).status, 400);
    assert.deepEqual(got, []);
  } finally {
    await h.close();
  }
});

test("status-line の route は onStatusLine が無い center では 404", async () => {
  const { h, base, tokens } = await boot();
  try {
    const t = tokens.issue("a");
    const r = await fetch(`${base}/sessions/a/status-line`, { method: "POST", headers: { authorization: `Bearer ${t}` }, body: "{}" });
    assert.equal(r.status, 404);
  } finally {
    await h.close();
  }
});

test("POST /sessions/<name>/hook: session token で JSON を受け取り 204。他 session・外向け token・token 無し・不正 token は 401 で onHook に渡らない。GET は 405", async () => {
  const got: { name: string; payload: unknown }[] = [];
  const { h, base, tokens } = await boot({ onHook: (name, payload) => got.push({ name, payload }) });
  try {
    const ta = tokens.issue("a");
    tokens.issue("b");
    const post = (n: string, headers: Record<string, string>, body: string) =>
      fetch(`${base}/sessions/${n}/hook`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body });
    const body = JSON.stringify({ hook_event_name: "Stop" });
    assert.equal((await post("a", { authorization: `Bearer ${ta}` }, body)).status, 204);
    assert.deepEqual(got, [{ name: "a", payload: JSON.parse(body) }]);
    for (const headers of [{ authorization: `Bearer ${ta}` }, AUTH, {}, { authorization: "Bearer nope" }]) {
      assert.equal((await post("b", headers, body)).status, 401);
    }
    assert.equal((await post("zzz", { authorization: `Bearer ${ta}` }, body)).status, 401);
    assert.equal(got.length, 1, "401 は反映しない");
    assert.equal((await fetch(`${base}/sessions/a/hook`, { method: "GET", headers: { authorization: `Bearer ${ta}` } })).status, 405);
    assert.equal((await post("a", { authorization: `Bearer ${ta}` }, "{oops")).status, 400);
    assert.equal((await post("a", { authorization: `Bearer ${ta}` }, "[]")).status, 400);
    assert.equal(got.length, 1);
  } finally {
    await h.close();
  }
});

test("hook の route は onHook が無い center では 404", async () => {
  const { h, base, tokens } = await boot();
  try {
    const t = tokens.issue("a");
    const r = await fetch(`${base}/sessions/a/hook`, { method: "POST", headers: { authorization: `Bearer ${t}` }, body: "{}" });
    assert.equal(r.status, 404);
  } finally {
    await h.close();
  }
});
