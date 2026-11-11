import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createCore } from "../src/core.js";
import { createEventHub } from "../src/events.js";
import { startHttpServer } from "../src/http.js";
import { createRemoteManager, type RemoteRecord } from "../src/remotes.js";
import { createSessionMcpServer } from "../src/server.js";
import type { ServerLink, ServerPeer } from "../src/server-link.js";
import { createSessionTokens } from "../src/session-auth.js";
import { createJsonListStore } from "../src/store.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "center-cps-http-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
});

const CENTER = "c-0123456789";
const peer: ServerPeer = { id: "id-a", name: "bantou-server", hostname: "host-a", version: "1.1.0" };

/** 実 RemoteManager を /mcp/session に繋ぐ（link だけ偽物）。 */
async function boot() {
  const stops: { cap_id: string }[] = [];
  const replies: { cap_id: string; worker_id: string }[] = [];
  const kicks: Record<string, unknown>[] = [];
  const link = {
    peers: async () => [peer],
    selectPeer: async () => peer,
    statusOn: async () => ({ bantou: 1, type: "status_result", ok: true, caps: kicks.map((k) => ({ kind: "cap", id: k.cap_id, state: "idle" })), workers: [] }),
    taskOn: (_p: ServerPeer, cmd: Record<string, unknown>) => new Promise(() => void kicks.push(cmd)),
    stopCapOn: async (_p: ServerPeer, cmd: { cap_id: string }) => (stops.push(cmd), { bantou: 1, type: "stop_result", ok: true, cap_id: cmd.cap_id, stopped: true, session_cleared: true, previous_session_id: "s-old" }),
    workerReplyOn: async (_p: ServerPeer, cmd: { cap_id: string; worker_id: string }) => (replies.push(cmd), { bantou: 1, type: "worker_reply_result", ok: true, cap_id: cmd.cap_id, worker_id: cmd.worker_id, accepted: true }),
  } as unknown as ServerLink;
  const store = createJsonListStore<RemoteRecord>(join(dir, "remotes.json"), () => {});
  const remotes = createRemoteManager({ link, store, log: () => {}, capId: CENTER, graceMs: 60, pollMs: 40, notify: async () => ({ ok: true }) });
  const tokens = createSessionTokens();
  const h = await startHttpServer({
    createServer: () => {
      throw new Error("外向けは使わない");
    },
    createSessionServer: (owner) => createSessionMcpServer({ remotes, owner }),
    sessionAuth: tokens,
    core: createCore(),
    events: createEventHub(),
    port: 0,
    log: () => {},
    bind: "127.0.0.1",
    token: "outer-token-0123456789",
  });
  return { h, tokens, remotes, stops, replies, kicks, base: `http://127.0.0.1:${h.port}` };
}

const connect = async (base: string, token: string, name: string): Promise<Client> => {
  const c = new Client({ name: "s", version: "0" });
  await c.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp/session`), { requestInit: { headers: { authorization: `Bearer ${token}`, "X-Bantou-Session": name } } }));
  return c;
};
const text = (r: unknown): string => ((r as { content: { text: string }[] }).content[0]?.text ?? "");
const isError = (r: unknown): boolean => (r as { isError?: boolean }).isError === true;

test("/mcp/session（実 RemoteManager）: 2 session の token で、別 session の cap は list に出ず delete / worker_reply も届かない。偽装は 401", async () => {
  const { h, tokens, stops, replies, base } = await boot();
  const ta = tokens.issue("alpha");
  const tb = tokens.issue("beta");
  const a = await connect(base, ta, "alpha");
  const b = await connect(base, tb, "beta");
  const alpha = `${CENTER}-alpha`;
  const beta = `${CENTER}-beta`;
  try {
    const sa = JSON.parse(text(await a.callTool({ name: "remote_send", arguments: { goal: "alpha の秘密の指示" } }))) as { remote_id: string };
    const sb = JSON.parse(text(await b.callTool({ name: "remote_send", arguments: { goal: "beta の指示" } }))) as { remote_id: string };
    assert.deepEqual([sa.remote_id, sb.remote_id], [alpha, beta]);

    // list: 自分の cap だけ
    const la = JSON.parse(text(await a.callTool({ name: "remote_list", arguments: {} }))) as { remote_id: string }[];
    const lb = text(await b.callTool({ name: "remote_list", arguments: {} }));
    assert.deepEqual(la.map((r) => r.remote_id), [alpha]);
    assert.deepEqual((JSON.parse(lb) as { remote_id: string }[]).map((r) => r.remote_id), [beta]);
    assert.ok(!lb.includes("秘密") && !lb.includes(alpha));

    // beta が alpha の remote_id を指定しても見えない・触れない
    const del = await b.callTool({ name: "remote_delete", arguments: { remote_id: alpha, force: true } });
    assert.ok(isError(del), text(del));
    assert.match(text(del), /未定義/);
    const rep = await b.callTool({ name: "worker_reply", arguments: { remote_id: alpha, worker_id: "w-1", text: "x" } });
    assert.ok(isError(rep), text(rep));
    const wait = await b.callTool({ name: "remote_wait", arguments: { remote_id: alpha, timeout_sec: 1 } });
    assert.ok(isError(wait), text(wait));
    assert.deepEqual(stops, []);
    assert.deepEqual(replies, []);

    // 自分の cap には届く（beta の worker_reply / delete は beta の cap_id）
    await b.callTool({ name: "worker_reply", arguments: { worker_id: "w-1", text: "y" } });
    assert.deepEqual(replies, [{ cap_id: beta, worker_id: "w-1", text: "y" }]);
    await b.callTool({ name: "remote_delete", arguments: { force: true } });
    assert.deepEqual(stops, [{ cap_id: beta }]);
    assert.deepEqual((JSON.parse(text(await a.callTool({ name: "remote_list", arguments: {} }))) as { remote_id: string }[]).map((r) => r.remote_id), [alpha]);

    // 偽装: beta の名前 + alpha の token は 401（initialize の時点で拒否される）
    const forged = await fetch(`${base}/mcp/session`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${ta}`, "x-bantou-session": "beta" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "0" } } }),
    });
    assert.equal(forged.status, 401);
  } finally {
    await Promise.all([a.close().catch(() => {}), b.close().catch(() => {})]);
    await h.close();
  }
});
