import assert from "node:assert/strict";
import { request } from "node:http";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startHttpServer } from "../src/http.js";
import { createCenterServer } from "../src/server.js";
import { parseConfig } from "../src/config.js";
import type { RemoteControlSupervisor } from "../src/remote-control.js";
import type { ServerLink } from "../src/server-link.js";

const TOOLS = ["cap_kick", "rc_list", "rc_start", "rc_status", "rc_stop", "server_list", "server_status", "worker_resume"];

async function boot(extra: { sessionIdleTtlMs?: number; sweepIntervalMs?: number; maxSessions?: number } = {}) {
  const config = parseConfig({}, "/tmp/c.json");
  const supervisor = {
    list: () => [],
    shutdown: async () => {},
  } as unknown as RemoteControlSupervisor;
  const link = { list: async () => [] } as unknown as ServerLink;
  const h = await startHttpServer({
    createServer: () => createCenterServer({ config, supervisor, link }),
    port: 0,
    bind: "127.0.0.1",
    log: () => {},
    ...extra,
  });
  return { h, url: new URL(`http://127.0.0.1:${h.port}/mcp`) };
}

test("http: 2 クライアントが並行に接続して tools/list と tool 呼び出しができる", async () => {
  const { h, url } = await boot();
  const clients = [new Client({ name: "a", version: "0" }), new Client({ name: "b", version: "0" })];
  try {
    await Promise.all(clients.map((c) => c.connect(new StreamableHTTPClientTransport(url))));
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
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      });
    assert.equal((await post({})).status, 400);
    assert.equal((await post({ "mcp-session-id": "nope" })).status, 404);
    assert.equal((await fetch(`${base}/mcp`)).status, 400);
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
const MCP_HEADERS = { "content-type": "application/json", accept: "application/json, text/event-stream" };

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
    const sse = await fetch(url, { headers: { accept: "text/event-stream", "mcp-session-id": live }, signal: ac.signal });
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
    const del = await fetch(url, { method: "DELETE", headers: { "mcp-session-id": sid } });
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
