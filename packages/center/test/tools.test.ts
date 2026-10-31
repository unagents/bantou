import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { parseConfig } from "../src/config.js";
import type { RcStatus, RemoteControlSupervisor } from "../src/remote-control.js";
import type { RemoteManager } from "../src/remotes.js";
import { createCenterServer, createSessionMcpServer } from "../src/server.js";
import type { SessionManager } from "../src/sessions.js";
import { resolveOwner } from "../src/tools.js";
import type { ServerLink } from "../src/server-link.js";
import type { Follow } from "../src/follow.js";

const rc = (project: string): RcStatus => ({
  project, path: "/p", state: "connected", pid: 1, sessionUrl: null, environmentUrl: null,
  restarts: 0, lastExit: null, startedAt: null, args: null,
  claude: { path: "claude", source: "PATH" },
});

async function connect(link: Partial<ServerLink> = {}, mgrs: { sessions?: Partial<SessionManager>; remotes?: Partial<RemoteManager>; follow?: Follow } = {}) {
  const calls: unknown[] = [];
  const supervisor: RemoteControlSupervisor = {
    start: async (p) => rc(p),
    stop: async (p) => ({ ...rc(p), state: "stopped" }),
    status: (p) => {
      if (p === "nope") throw new Error("未定義の project: nope");
      return rc(p);
    },
    list: () => [rc("a"), rc("b")],
    shutdown: async () => {},
  };
  const fullLink: ServerLink = {
    connectAll: async () => {},
    list: async () => [{ name: "s", connected: true, reachable: true, peerId: "x" }],
    kickCap: async (s, cmd) => {
      calls.push({ s, cmd });
      return { bantou: 1, type: "cap_result", cap_id: cmd.cap_id, session_id: "sid", ok: true, result_text: "done" };
    },
    resumeWorker: async (_s, cmd) => ({
      bantou: 1, type: "worker_result", worker_id: cmd.worker_id, session_id: "sid", ok: false, result_text: "", error: "bad",
    }),
    status: async () => ({ bantou: 1, type: "error", ok: false, message: "ng", command: "status" }),
    close: async () => {},
    ...link,
  };
  const sessions = { create: async (i: unknown) => ({ called: "create", i }), delete: async (n: string) => ({ name: n, deleted: true }), list: () => [], ...mgrs.sessions } as unknown as SessionManager;
  const remotes = {
    create: async (i: unknown) => (calls.push({ remoteCreate: i }), { remote_id: "r-1", server: "id", serverName: "n", state: "running", owner: "x", createdAt: "t" }),
    delete: async (i: unknown) => (calls.push({ remoteDelete: i }), { remote_id: "r-1", deleted: true, stopped: true }),
    list: (f: unknown) => (calls.push({ remoteList: f }), []),
    ...mgrs.remotes,
  } as unknown as RemoteManager;
  const server = createCenterServer({ config: parseConfig({}, "/x/c.json"), supervisor, link: fullLink, sessions, remotes, follow: mgrs.follow });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "0" });
  await Promise.all([server.connect(st), client.connect(ct)]);
  /** session 向け窓口（/mcp/session 相当）の MCP server に owner 付きで繋ぐ。 */
  const session = async (owner: string) => {
    const s = createSessionMcpServer({ remotes, owner });
    const [c2, s2] = InMemoryTransport.createLinkedPair();
    const cl = new Client({ name: "ts", version: "0" });
    await Promise.all([s.connect(s2), cl.connect(c2)]);
    return cl;
  };
  return { client, calls, session, close: () => client.close() };
}

const text = (r: unknown): string => (r as { content: { text: string }[] }).content[0].text;

test("外向けの tool は 12 個。remote_create / remote_delete / cap_kick は無い", async () => {
  const { client, close } = await connect();
  const names = (await client.listTools()).tools.map((t) => t.name).sort();
  assert.deepEqual(names, [
    "rc_list", "rc_start", "rc_status", "rc_stop", "remote_list",
    "server_list", "server_peers", "server_status", "session_create", "session_delete", "session_list", "worker_resume",
  ]);
  for (const gone of ["remote_create", "remote_delete", "cap_kick"]) assert.ok(!names.includes(gone), gone);
  await close();
});

test("session 向けの tool は remote_create / remote_delete / remote_list の 3 つだけ", async () => {
  const { session, close } = await connect();
  const c = await session("pm1");
  assert.deepEqual((await c.listTools()).tools.map((t) => t.name).sort(), ["remote_create", "remote_delete", "remote_list"]);
  await c.close();
  await close();
});

test("rc_list は RcStatus[] を JSON で返す", async () => {
  const { client, close } = await connect();
  const r = await client.callTool({ name: "rc_list", arguments: {} });
  assert.notEqual(r.isError, true);
  assert.deepEqual((JSON.parse(text(r)) as RcStatus[]).map((s) => s.project), ["a", "b"]);
  await close();
});

test("rc_status の例外は isError + {error}", async () => {
  const { client, close } = await connect();
  const r = await client.callTool({ name: "rc_status", arguments: { project: "nope" } });
  assert.equal(r.isError, true);
  assert.deepEqual(JSON.parse(text(r)), { error: "未定義の project: nope" });
  await close();
});

test("cap_kick は外向けから呼べない", async () => {
  const { client, calls, close } = await connect();
  const r = await client.callTool({ name: "cap_kick", arguments: { server: "s", cap_id: "c-1", prompt: "go" } }).catch((e: unknown) => e);
  assert.ok(r instanceof Error || (r as { isError?: boolean }).isError === true);
  assert.equal(calls.length, 0);
  await close();
});

test("worker_resume: 入力検証エラー（worker_id / prompt / repo / branch）", async () => {
  const { client, calls, close } = await connect();
  const bad = [
    { server: "s", worker_id: "a/b", prompt: "x" },
    { server: "s", worker_id: "ok", prompt: "" },
    { server: "s", worker_id: "ok", prompt: "x", repo: "--upload-pack=evil" },
    { server: "s", worker_id: "ok", prompt: "x", branch: "-b" },
  ];
  for (const args of bad) {
    let isError = false;
    try {
      const r = await client.callTool({ name: "worker_resume", arguments: args });
      isError = r.isError === true;
    } catch {
      isError = true;
    }
    assert.ok(isError, JSON.stringify(args));
  }
  assert.equal(calls.length, 0);
  await close();
});

test("worker_resume は NUL を含む prompt / repo / branch / id を拒否", async () => {
  const { client, close } = await connect();
  for (const extra of [{ prompt: "a\0" }, { repo: "u\0" }, { branch: "b\0" }, { worker_id: "w\0" }]) {
    const args = { server: "s", worker_id: "w", prompt: "x", ...extra };
    let isError = false;
    try {
      isError = (await client.callTool({ name: "worker_resume", arguments: args })).isError === true;
    } catch {
      isError = true;
    }
    assert.ok(isError, JSON.stringify(args));
  }
  await close();
});

test("worker_resume の ok:false と server_status の error 返信は isError", async () => {
  const { client, close } = await connect();
  const w = await client.callTool({ name: "worker_resume", arguments: { server: "s", worker_id: "w", prompt: "x" } });
  assert.equal(w.isError, true);
  assert.equal((JSON.parse(text(w)) as { error: string }).error, "bad");
  const s = await client.callTool({ name: "server_status", arguments: { server: "s" } });
  assert.equal(s.isError, true);
  assert.equal((JSON.parse(text(s)) as { type: string }).type, "error");
  await close();
});

test("server_list / rc_start / rc_stop", async () => {
  const { client, close } = await connect();
  const l = await client.callTool({ name: "server_list", arguments: {} });
  assert.equal((JSON.parse(text(l)) as { name: string }[])[0].name, "s");
  const a = await client.callTool({ name: "rc_start", arguments: { project: "a" } });
  assert.equal((JSON.parse(text(a)) as RcStatus).state, "connected");
  const b = await client.callTool({ name: "rc_stop", arguments: { project: "a" } });
  assert.equal((JSON.parse(text(b)) as RcStatus).state, "stopped");
  await close();
});

test("session_create / session_delete / session_list は SessionManager に委譲し、例外は isError", async () => {
  const { client, close } = await connect({}, {
    sessions: { create: async (i) => { if (i.name === "dup") throw new Error("name が既に使われている: dup"); return { name: i.name, path: "/p", state: "starting" } as never; } },
  });
  const ok = await client.callTool({ name: "session_create", arguments: { name: "pm1", permissionMode: "plan" } });
  assert.deepEqual(JSON.parse(text(ok)), { name: "pm1", path: "/p", state: "starting" });
  const dup = await client.callTool({ name: "session_create", arguments: { name: "dup" } });
  assert.equal(dup.isError, true);
  assert.deepEqual(JSON.parse(text(dup)), { error: "name が既に使われている: dup" });
  const bad = await client.callTool({ name: "session_create", arguments: { name: "a b" } }).catch((e: unknown) => e);
  assert.ok(bad instanceof Error || (bad as { isError?: boolean }).isError === true);
  assert.deepEqual(JSON.parse(text(await client.callTool({ name: "session_delete", arguments: { name: "pm1" } }))), { name: "pm1", deleted: true });
  assert.deepEqual(JSON.parse(text(await client.callTool({ name: "session_list", arguments: {} }))), []);
  await close();
});

test("remote_create: owner は session の認証済み名で固定。引数 owner は受けない。返り値は remote_id / server / state", async () => {
  const { session, calls, close } = await connect();
  const c = await session("pm1");
  const ok = await c.callTool({ name: "remote_create", arguments: { prompt: "go", server: "id", repo: "https://x/y.git" } });
  assert.deepEqual(JSON.parse(text(ok)), { remote_id: "r-1", server: "id", serverName: "n", state: "running" });
  // 自己申告の owner は schema に無いので、渡しても無視され呼び出し元の名前になる
  await c.callTool({ name: "remote_create", arguments: { prompt: "go2", owner: "evil" } });
  assert.deepEqual(calls, [
    { remoteCreate: { owner: "pm1", prompt: "go", server: "id", repo: "https://x/y.git" } },
    { remoteCreate: { owner: "pm1", prompt: "go2" } },
  ]);
  await c.close();
  await close();
});

test("remote_delete / remote_list: session 向けは常に自分の owner。外向け remote_list は owner 引数で絞る（無ければ全件）", async () => {
  const { client, session, calls, close } = await connect();
  const c = await session("pm1");
  await c.callTool({ name: "remote_list", arguments: {} });
  await c.callTool({ name: "remote_delete", arguments: { remote_id: "r-1" } });
  await c.callTool({ name: "remote_delete", arguments: { remote_id: "r-1", force: true, owner: "evil" } });
  await client.callTool({ name: "remote_list", arguments: {} });
  await client.callTool({ name: "remote_list", arguments: { owner: "pm1" } });
  assert.deepEqual(calls, [
    { remoteList: { owner: "pm1" } },
    { remoteDelete: { remote_id: "r-1", owner: "pm1" } },
    { remoteDelete: { remote_id: "r-1", owner: "pm1", force: true } },
    { remoteList: {} }, { remoteList: { owner: "pm1" } },
  ]);
  await c.close();
  await close();
});

test("resolveOwner: header > query > 引数。不正な形式は投げる", () => {
  const url = (q: string) => new URL(`http://h/mcp${q}`);
  assert.equal(resolveOwner({ requestInfo: { headers: { "x-bantou-session": "h" }, url: url("?session=q") } }, "a"), "h");
  assert.equal(resolveOwner({ requestInfo: { headers: { "x-bantou-session": ["h1", "h2"] } } }), "h1");
  assert.equal(resolveOwner({ requestInfo: { headers: {}, url: url("?session=q") } }, "a"), "q");
  assert.equal(resolveOwner({ requestInfo: { headers: {} } }, "a"), "a");
  assert.equal(resolveOwner(undefined), undefined);
  assert.throws(() => resolveOwner({ requestInfo: { headers: { "x-bantou-session": "a b" } } }), /owner/);
});

test("server_peers: follow の snapshot（pair と server ごとの状態）をそのまま返す。refresh: true なら先に確認する", async () => {
  const checks: string[] = [];
  const snap = {
    pair: { server: "0.3.1", protocol: "1.3.0" },
    peers: [{ key: "h /ws", id: "id-1", name: "bantou-server", server_version: "0.3.0", protocol_version: "1.3.0", state: "updating", detail: "更新中", update: { to: "0.3.1", running: { caps: 1, workers: 0, reports: 0 } }, since: "2026-10-31T00:00:00.000Z" }],
  };
  const follow = { check: async () => void checks.push("check"), snapshot: () => snap } as unknown as Follow;
  const { client, close } = await connect({}, { follow });
  const a = await client.callTool({ name: "server_peers", arguments: {} });
  assert.notEqual(a.isError, true);
  assert.deepEqual(JSON.parse(text(a)), snap);
  assert.deepEqual(checks, []);
  await client.callTool({ name: "server_peers", arguments: { refresh: true } });
  assert.deepEqual(checks, ["check"]);
  await close();
});

test("server_peers: follow が無ければ isError", async () => {
  const { client, close } = await connect();
  const r = await client.callTool({ name: "server_peers", arguments: {} });
  assert.equal(r.isError, true);
  await close();
});
