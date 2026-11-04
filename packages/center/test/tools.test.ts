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

async function connect(link: Partial<ServerLink> = {}, mgrs: { sessions?: Partial<SessionManager>; remotes?: Partial<RemoteManager>; follow?: Follow; workspace?: string } = {}) {
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
  const sessions = { create: async (i: unknown) => ({ called: "create", i }), getSettings: (n: string) => ({ called: "get", n }), updateSettings: async (n: string, p: unknown) => ({ called: "update", n, p }), delete: async (n: string) => ({ name: n, deleted: true }), list: () => [], ...mgrs.sessions } as unknown as SessionManager;
  const remotes = {
    send: async (i: unknown) => (calls.push({ remoteSend: i }), { remote_id: "c-1", server: "id", serverName: "n", state: "running", created: false, task_id: "t-1" }),
    workerReply: async (i: unknown) => (calls.push({ workerReply: i }), { remote_id: "c-1", server: "id", worker_id: "w-1", accepted: true }),
    delete: async (i: unknown) => (calls.push({ remoteDelete: i }), { remote_id: "r-1", deleted: true, stopped: true }),
    list: (f: unknown) => (calls.push({ remoteList: f }), []),
    ...mgrs.remotes,
  } as unknown as RemoteManager;
  const server = createCenterServer({ config: parseConfig(mgrs.workspace ? { workspace: mgrs.workspace } : {}, "/x/c.json"), supervisor, link: fullLink, sessions, remotes, follow: mgrs.follow });
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

test("外向けの tool は 19 個。remote_create / remote_delete / remote_send / cap_kick は無い", async () => {
  const { client, close } = await connect();
  const names = (await client.listTools()).tools.map((t) => t.name).sort();
  assert.deepEqual(names, [
    "center_info", "center_settings_get", "center_settings_update", "rc_list", "rc_start", "rc_status", "rc_stop", "remote_list", "remote_wait",
    "server_list", "server_peers", "server_status", "session_create", "session_delete", "session_list", "session_settings_get", "session_settings_update", "worker_reply", "worker_resume",
  ]);
  for (const gone of ["remote_create", "remote_send", "remote_delete", "cap_kick"]) assert.ok(!names.includes(gone), gone);
  await close();
});

test("center_info は { workspace } を返す。未設定は null", async () => {
  const a = await connect({}, { workspace: "/w/ws" });
  const r = await a.client.callTool({ name: "center_info", arguments: {} });
  assert.notEqual(r.isError, true);
  assert.deepEqual(JSON.parse(text(r)), { workspace: "/w/ws" });
  await a.close();
  const b = await connect();
  assert.deepEqual(JSON.parse(text(await b.client.callTool({ name: "center_info", arguments: {} }))), { workspace: null });
  await b.close();
});

test("session 向けの tool は remote_send / remote_create（別名）/ remote_delete / remote_list / remote_wait / worker_reply の 6 つだけ", async () => {
  const { session, close } = await connect();
  const c = await session("pm1");
  assert.deepEqual((await c.listTools()).tools.map((t) => t.name).sort(), ["remote_create", "remote_delete", "remote_list", "remote_send", "remote_wait", "worker_reply"]);
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

test("remote_send / remote_create（別名）: owner は session の認証済み名で固定。同じ処理。goal 以外の task の項目と worker_model は渡せる。引数 owner・model は受けない", async () => {
  const { session, calls, close } = await connect();
  const c = await session("pm1");
  const ok = await c.callTool({ name: "remote_send", arguments: { goal: "go", server: "id" } });
  assert.deepEqual(JSON.parse(text(ok)), { remote_id: "c-1", server: "id", serverName: "n", state: "running", created: false, task_id: "t-1" });
  const alias = await c.callTool({ name: "remote_create", arguments: { goal: "go2" } });
  assert.deepEqual(JSON.parse(text(alias)), JSON.parse(text(ok)));
  // 自己申告の owner・model は schema に無いので、渡しても無視される
  await c.callTool({ name: "remote_send", arguments: { goal: "go3", owner: "evil", model: "opus", worker_model: "haiku", repo: "https://x/y.git", branch: "main" } });
  const full = { deliverables: { branch: "f" }, verify: { tests: ["t"] }, constraints: ["c"], workers: { items: [{ role: "review", scope: "s" }] } };
  await c.callTool({ name: "remote_create", arguments: { goal: "go4", worker_model: "sonnet", ...full } });
  assert.deepEqual(calls, [
    { remoteSend: { owner: "pm1", goal: "go", server: "id" } },
    { remoteSend: { owner: "pm1", goal: "go2" } },
    { remoteSend: { owner: "pm1", goal: "go3", repo: "https://x/y.git", branch: "main", worker_model: "haiku" } },
    { remoteSend: { owner: "pm1", goal: "go4", worker_model: "sonnet", ...full } },
  ]);
  // prompt だけ（旧形式）・形式が不正な worker_model は schema で拒否され、remotes.send は呼ばれない
  const old = await c.callTool({ name: "remote_send", arguments: { prompt: "x" } });
  assert.equal(old.isError, true);
  const bad = await c.callTool({ name: "remote_send", arguments: { goal: "x", worker_model: "a b" } });
  assert.equal(bad.isError, true);
  assert.equal(calls.length, 4);
  await c.close();
  await close();
});

test("worker_reply: session 向け・外向け（desktop の center_call）とも {remote_id?, worker_id, text, server?} を remotes.workerReply へ渡す。不正な worker_id・空の text は拒否。失敗は isError", async () => {
  const { client, session, calls, close } = await connect(undefined, { remotes: { workerReply: async (i: unknown) => { calls.push({ workerReply: i }); if ((i as { text: string }).text === "boom") throw new Error("版が合わない"); return { remote_id: "c-1", server: "id", worker_id: "w-1", accepted: true } as never; } } });
  const c = await session("pm1");
  const r = await c.callTool({ name: "worker_reply", arguments: { worker_id: "w-1", text: "OK 進めて" } });
  assert.deepEqual(JSON.parse(text(r)), { remote_id: "c-1", server: "id", worker_id: "w-1", accepted: true });
  const o = await client.callTool({ name: "worker_reply", arguments: { remote_id: "c-1", worker_id: "w-1", text: "はい", server: "id" } });
  assert.equal(o.isError, undefined);
  // session 向けは呼び出し元 session の owner を渡す。外向け（desktop）は渡さない
  assert.deepEqual(calls.slice(0, 2), [{ workerReply: { owner: "pm1", worker_id: "w-1", text: "OK 進めて" } }, { workerReply: { remote_id: "c-1", worker_id: "w-1", text: "はい", server: "id" } }]);
  assert.equal((await c.callTool({ name: "worker_reply", arguments: { worker_id: "a b", text: "x" } })).isError, true);
  assert.equal((await c.callTool({ name: "worker_reply", arguments: { worker_id: "w-1", text: "" } })).isError, true);
  const e = await c.callTool({ name: "worker_reply", arguments: { worker_id: "w-1", text: "boom" } });
  assert.equal(e.isError, true);
  assert.match(text(e), /版が合わない/);
  await c.close();
  await close();
});

test("remote_delete / remote_list: remote_list は session 向けなら自分の owner。remote_delete は呼び出し元 session の owner を渡す（引数 owner は受けない）。include_shared で旧共有 cap も。外向け remote_list は owner 引数で絞る（無ければ全件）", async () => {
  const { client, session, calls, close } = await connect();
  const c = await session("pm1");
  await c.callTool({ name: "remote_list", arguments: {} });
  await c.callTool({ name: "remote_delete", arguments: {} });
  await c.callTool({ name: "remote_delete", arguments: { remote_id: "c-1", server: "id", force: true, owner: "evil" } });
  await c.callTool({ name: "remote_list", arguments: { include_shared: true } });
  await client.callTool({ name: "remote_list", arguments: {} });
  await client.callTool({ name: "remote_list", arguments: { owner: "pm1" } });
  assert.deepEqual(calls, [
    { remoteList: { owner: "pm1" } },
    { remoteDelete: { owner: "pm1" } },
    { remoteDelete: { owner: "pm1", remote_id: "c-1", server: "id", force: true } },
    { remoteList: { owner: "pm1", includeShared: true } },
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

test("remote_wait: session 向けは自分の owner で待ち、引数を渡す。外向けは owner を header / 引数から解決する", async () => {
  const { client, calls, session, close } = await connect({}, { remotes: { wait: async (i: unknown) => (calls.push({ remoteWait: i }), { remote_id: "r-1", state: "running" }) } as never });
  const c = await session("pm1");
  const r = await c.callTool({ name: "remote_wait", arguments: { remote_id: "c-1", server: "id", timeout_sec: 5 } });
  assert.equal(JSON.parse(text(r)).state, "running");
  await c.callTool({ name: "remote_wait", arguments: {} });
  await client.callTool({ name: "remote_wait", arguments: { owner: "pm2" } });
  assert.deepEqual(calls, [
    { remoteWait: { owner: "pm1", remote_id: "c-1", server: "id", timeoutSec: 5 } },
    { remoteWait: { owner: "pm1" } },
    { remoteWait: { owner: "pm2" } },
  ]);
  const bad = await c.callTool({ name: "remote_wait", arguments: { timeout_sec: 1801 } });
  assert.equal(bad.isError, true);
  await c.close();
  await close();
});

test("session_create の settings は SessionManager.create にそのまま渡る（未知項目も）。長すぎる instructions は拒否", async () => {
  const { client, close } = await connect();
  const r = await client.callTool({ name: "session_create", arguments: { name: "pm1", settings: { instructions: "あ\nい", future: [1] } } });
  assert.deepEqual(JSON.parse(text(r)), { called: "create", i: { name: "pm1", settings: { instructions: "あ\nい", future: [1] } } });
  const long = await client.callTool({ name: "session_create", arguments: { name: "pm2", settings: { instructions: "a".repeat(16_001) } } }).catch((e: unknown) => e);
  assert.ok(long instanceof Error || (long as { isError?: boolean }).isError === true);
  await close();
});

test("center_settings_get / center_settings_update は SessionManager に委譲する。null と未知項目を通し、長すぎ・不正は拒否", async () => {
  const seen: unknown[] = [];
  const { client, close } = await connect({}, {
    sessions: {
      getCenterSettings: () => ({ settings: { instructions: "共通" } }),
      updateCenterSettings: async (p) => { seen.push(p); return { settings: { ...p, instructions: "後" } }; },
    },
  });
  assert.deepEqual(JSON.parse(text(await client.callTool({ name: "center_settings_get", arguments: {} }))), { settings: { instructions: "共通" } });
  const u = await client.callTool({ name: "center_settings_update", arguments: { settings: { instructions: null, skills: ["a"] } } });
  assert.deepEqual(JSON.parse(text(u)), { settings: { instructions: "後", skills: ["a"] } });
  assert.deepEqual(seen, [{ instructions: null, skills: ["a"] }]);
  for (const args of [{ settings: { instructions: "a".repeat(16_001) } }, { settings: { instructions: 1 } }, { settings: "x" }, {}]) {
    const r = await client.callTool({ name: "center_settings_update", arguments: args }).catch((e: unknown) => e);
    assert.ok(r instanceof Error || (r as { isError?: boolean }).isError === true, JSON.stringify(args).slice(0, 60));
  }
  await close();
});

test("session_settings_get / session_settings_update は SessionManager に委譲する。null と未知項目を通し、長すぎ・不正 name は拒否", async () => {
  const { client, close } = await connect();
  const g = await client.callTool({ name: "session_settings_get", arguments: { name: "pm1" } });
  assert.deepEqual(JSON.parse(text(g)), { called: "get", n: "pm1" });
  const u = await client.callTool({ name: "session_settings_update", arguments: { name: "pm1", settings: { instructions: null, skills: ["a"] } } });
  assert.deepEqual(JSON.parse(text(u)), { called: "update", n: "pm1", p: { instructions: null, skills: ["a"] } });
  for (const args of [
    { name: "pm1", settings: { instructions: "a".repeat(16_001) } },
    { name: "a b", settings: {} },
    { name: "pm1", settings: { instructions: 1 } },
    { name: "pm1", settings: "x" },
  ]) {
    const r = await client.callTool({ name: "session_settings_update", arguments: args }).catch((e: unknown) => e);
    assert.ok(r instanceof Error || (r as { isError?: boolean }).isError === true, JSON.stringify(args).slice(0, 60));
  }
  await close();
});
