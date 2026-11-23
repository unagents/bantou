import assert from "node:assert/strict";
import { test } from "node:test";
import { describeSystemInstructions } from "../src/system-instructions.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { parseConfig } from "../src/config.js";
import type { RcStatus, RemoteControlSupervisor } from "../src/remote-control.js";
import type { RemoteManager } from "../src/remotes.js";
import { createCenterServer, createSessionMcpServer } from "../src/server.js";
import type { SessionManager } from "../src/sessions.js";
import { resolveOwner } from "../src/tools.js";
import { CENTER_ONLY_MCP_ERROR, LEGACY_KEYS_ERROR } from "../src/project-settings.js";
import type { ServerLink } from "../src/server-link.js";
import type { LoginFlow } from "../src/login.js";

const rc = (project: string): RcStatus => ({
  project, path: "/p", state: "connected", pid: 1, sessionUrl: null, environmentUrl: null,
  restarts: 0, lastExit: null, startedAt: null, args: null,
  claude: { path: "claude", source: "PATH" },
  auth: "ok", loginUrl: null, loginError: null,
});

async function connect(link: Partial<ServerLink> = {}, mgrs: { sessions?: Partial<SessionManager>; remotes?: Partial<RemoteManager>; login?: LoginFlow; workspace?: string; systemInstructions?: { id: string; version: number; title: string }[]; launcher?: boolean; resession?: { requestSleep: (name: string) => Promise<never> } } = {}) {
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
    name: "bantou-center-0123456789",
    connect: async () => {},
    launch: async () => {},
    stop: async () => {},
    reply: async () => {},
    requestServerInfo: async () => {},
    serverVersionOf: () => undefined,
    notifyPeer: async () => ({ ok: false, reason: "n/a" }),
    peerMarkOf: async () => null,
    close: async () => {},
    ...link,
  };
  const sessions = { create: async (i: unknown) => ({ called: "create", i }), getSettings: (n: string) => ({ called: "get", n, settings: {} }), updateSettings: async (n: string, p: unknown) => ({ called: "update", n, p, settings: {} }), delete: async (n: string) => ({ name: n, deleted: true }), list: () => [], ...mgrs.sessions } as unknown as SessionManager;
  const remotes = {
    send: async (i: unknown) => (calls.push({ remoteSend: i }), { remote_id: "pm1-cap", server: (i as { server: string }).server, model: (i as { model?: string }).model ?? "sonnet", sent: true }),
    reply: async (i: unknown) => (calls.push({ reply: i }), { server: "srv-a", session_id: "s-1", order: "answer", sent: true }),
    stop: async (i: unknown) => (calls.push({ remoteStop: i }), { remote_id: "pm1-cap", server: (i as { server: string }).server, sent: true, forgotten: true }),
    list: (f: unknown) => (calls.push({ remoteList: f }), []),
    scopeOf: () => ({ servers: undefined, out_of_scope: 0 }),
    ...mgrs.remotes,
  } as unknown as RemoteManager;
  const server = createCenterServer({ ...(mgrs.systemInstructions ? { systemInstructions: mgrs.systemInstructions } : {}), config: parseConfig(mgrs.workspace ? { workspace: mgrs.workspace } : {}, "/x/c.json"), supervisor, link: fullLink, sessions, remotes, login: mgrs.login, ...(mgrs.launcher !== undefined ? { launcher: mgrs.launcher } : {}), ...(mgrs.resession ? { resession: mgrs.resession } : {}) });
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
  /** 同じ、版の控え（link.serverVersionOf）を渡した session 向け窓口。省略時は版が全部不明。 */
  const sessionWithLink = async (owner: string, linkLike: Pick<ServerLink, "serverVersionOf"> = { serverVersionOf: () => undefined }) => {
    const s = createSessionMcpServer({ remotes, link: linkLike, owner });
    const [c2, s2] = InMemoryTransport.createLinkedPair();
    const cl = new Client({ name: "ts", version: "0" });
    await Promise.all([s.connect(s2), cl.connect(c2)]);
    return cl;
  };
  return { client, calls, session, sessionWithLink, close: () => client.close() };
}

const text = (r: unknown): string => (r as { content: { text: string }[] }).content[0].text;

test("外向けの tool は 20 個。remote_create / remote_stop / remote_send / remote_delete / cap_kick は無い", async () => {
  const { client, close } = await connect();
  const names = (await client.listTools()).tools.map((t) => t.name).sort();
  assert.deepEqual(names, [
    "center_info", "center_settings_get", "center_settings_update", "rc_list", "rc_start", "rc_status", "rc_stop", "remote_list", "remote_wait",
    "session_create", "session_delete", "session_list", "session_login", "session_login_code", "session_settings_get", "session_settings_update", "session_sleep", "session_update", "session_wake", "worker_reply",
  ]);
  for (const gone of ["remote_create", "remote_send", "remote_stop", "remote_delete", "cap_kick"]) assert.ok(!names.includes(gone), gone);
  await close();
});

/** schema を再帰的に辿り、`pattern`（文字列）をすべて集める。 */
function collectPatterns(node: unknown, path: string, out: { path: string; pattern: string }[]): void {
  if (Array.isArray(node)) return node.forEach((v, i) => collectPatterns(v, `${path}[${i}]`, out));
  if (node === null || typeof node !== "object") return;
  for (const [k, v] of Object.entries(node)) {
    if (k === "pattern" && typeof v === "string") out.push({ path, pattern: v });
    else collectPatterns(v, `${path}.${k}`, out);
  }
}

/**
 * 文字 class の中にある escape の無い `[` の位置（無ければ -1）。`\[` は可。class の外の `[` は class の開始として扱う。
 * Claude の API が tool の schema を「JSON schema is invalid」で弾く形を捉えるための検査。
 * この基準は実測 2 例（`[A-Za-z0-9._[\]]` は弾かれ、`[A-Za-z0-9._\[\]]` は通った）から作った推測で、API の本当の基準ではない。
 * 本当に通るかは実際の API で確かめる（docs/history/20261120-fix-tool-schema-pattern/report.md）。
 */
function unescapedBracketInClass(p: string): number {
  let inClass = false;
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === "\\") i++;
    else if (!inClass) inClass = c === "[";
    else if (c === "]") inClass = false;
    else if (c === "[") return i;
  }
  return -1;
}

/** pattern のうち、`u` で compile できない物と、文字 class の中に escape の無い `[` を持つ物。 */
function badPatterns(found: { path: string; pattern: string }[]): string[] {
  const bad: string[] = [];
  for (const f of found) {
    try {
      new RegExp(f.pattern, "u");
    } catch (e) {
      bad.push(`${f.path} /${f.pattern}/u: ${(e as Error).message}`);
    }
    const at = unescapedBracketInClass(f.pattern);
    if (at >= 0) bad.push(`${f.path} /${f.pattern}/: 文字 class の中に escape の無い [（位置 ${at}）`);
  }
  return bad;
}

test("pattern の検査: 文字 class の中の escape の無い [ だけを不正とする", () => {
  const bad = (p: string) => badPatterns([{ path: "x", pattern: p }]).length > 0;
  assert.equal(bad("^[A-Za-z0-9._[\\]][A-Za-z0-9._[\\]-]*$"), true, "修正前の worker_start.model");
  assert.equal(bad("^[A-Za-z0-9._\\[\\]][A-Za-z0-9._\\[\\]-]*$"), false, "[ ] だけ escape した形");
  assert.equal(bad("^[A-Za-z0-9_-]+$"), false, "escape の無い - は可");
  assert.equal(bad("^[+-]\\d{2}$"), false);
  assert.equal(bad("^\\[[a-z]+\\]$"), false, "class の外の \\[");
  assert.equal(bad("^[a-z][0-9]$"), false, "class が 2 つ");
  assert.equal(bad("[a[b]"), true);
  assert.equal(bad("(a"), true, "compile できない");
});

test("全 tool の inputSchema の pattern は u で compile でき、文字 class の中に escape の無い [ を持たない（Claude の API に schema を弾かれない形）", async () => {
  const { client, session, close } = await connect();
  const c = await session("pm1");
  const found: { path: string; pattern: string }[] = [];
  for (const [label, cl] of [["center", client], ["session", c]] as const) {
    const tools = (await cl.listTools()).tools;
    assert.ok(tools.length > 0, label);
    for (const t of tools) collectPatterns(t.inputSchema, `${label}:${t.name}`, found);
  }
  // remote_send の model まで辿れている事（辿り漏れの検出）
  assert.ok(found.some((f) => f.path.startsWith("session:remote_send") && f.path.endsWith(".model")), "model");
  if (process.env.PATTERN_DUMP) console.log("PATTERN_DUMP " + JSON.stringify(found));
  assert.deepEqual(badPatterns(found), []);
  await c.close();
  await close();
});

test("center_info は { workspace, systemInstructions, launcher } を返す。未設定は null / [] / false（launcher は呼び出し元が center を起動した所か）", async () => {
  const parts = [{ id: "master-cap-role", version: 1, title: "役割" }];
  const a = await connect({}, { workspace: "/w/ws", systemInstructions: parts, launcher: true });
  const r = await a.client.callTool({ name: "center_info", arguments: {} });
  assert.notEqual(r.isError, true);
  assert.deepEqual(JSON.parse(text(r)), { workspace: "/w/ws", systemInstructions: parts, launcher: true });
  await a.close();
  const b = await connect();
  // 指定が無ければ center 組み込みの部品。起動元の指定が無ければ launcher: false
  assert.deepEqual(JSON.parse(text(await b.client.callTool({ name: "center_info", arguments: {} }))), { workspace: null, systemInstructions: describeSystemInstructions(), launcher: false });
  await b.close();
});

test("session 向けの tool は remote_send / remote_create（別名）/ remote_stop / remote_list / remote_wait / worker_reply / task_status の 7 つだけ", async () => {
  const { session, close } = await connect();
  const c = await session("pm1");
  assert.deepEqual((await c.listTools()).tools.map((t) => t.name).sort(), ["remote_create", "remote_list", "remote_send", "remote_stop", "remote_wait", "task_status", "worker_reply"]);
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

test("旧 1.x の道具（worker_resume / server_status / server_list / server_peers / server_retire）は無い", async () => {
  const { client, session, close } = await connect();
  const names = new Set((await client.listTools()).tools.map((t) => t.name));
  const c = await session("pm1");
  for (const n of ["worker_resume", "server_status", "server_list", "server_peers", "server_retire", "remote_delete"]) {
    assert.ok(!names.has(n), n);
    assert.ok(!(await c.listTools()).tools.some((t) => t.name === n), `session:${n}`);
  }
  await c.close();
  await close();
});

test("rc_start / rc_stop", async () => {
  const { client, close } = await connect();
  const a = await client.callTool({ name: "rc_start", arguments: { project: "a" } });
  assert.equal((JSON.parse(text(a)) as RcStatus).state, "connected");
  const b = await client.callTool({ name: "rc_stop", arguments: { project: "a" } });
  assert.equal((JSON.parse(text(b)) as RcStatus).state, "stopped");
  await close();
});

test("session_create: start: false は SessionManager へ渡る（本物の schema。落ちると起動してしまう）", async () => {
  const { client, close } = await connect();
  const tool = (await client.listTools()).tools.find((t) => t.name === "session_create")!;
  assert.ok("start" in (tool.inputSchema.properties as object), "schema に start が在る");
  await close();
  const seen: unknown[] = [];
  const c2 = await connect({}, { sessions: { create: async (i: unknown) => (seen.push(i), { name: "pm1" }) as never } });
  await c2.client.callTool({ name: "session_create", arguments: { name: "pm1", start: false } });
  await c2.client.callTool({ name: "session_create", arguments: { name: "pm2" } });
  assert.equal((seen[0] as { start?: boolean }).start, false);
  assert.equal("start" in (seen[1] as object), false, "省略は渡さない（起動する）");
  await c2.close();
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

test("session_update は SessionManager に引数をそのまま委譲し、例外は isError。name 以外は省略可・不正な名前は弾く", async () => {
  const seen: unknown[] = [];
  const { client, close } = await connect({}, {
    sessions: { update: async (i) => { seen.push(i); if (i.newName === "dup") throw new Error("name が既に使われている: dup"); return { name: i.newName ?? i.name, path: i.path ?? "/p", state: "connected" } as never; } },
  });
  const ok = await client.callTool({ name: "session_update", arguments: { name: "pm1", newName: "pm2", path: "/new/p", move: true } });
  assert.deepEqual(JSON.parse(text(ok)), { name: "pm2", path: "/new/p", state: "connected" });
  await client.callTool({ name: "session_update", arguments: { name: "pm1", path: "/only/path" } });
  assert.deepEqual(seen, [{ name: "pm1", newName: "pm2", path: "/new/p", move: true }, { name: "pm1", path: "/only/path" }]);
  const dup = await client.callTool({ name: "session_update", arguments: { name: "pm1", newName: "dup" } });
  assert.equal(dup.isError, true);
  assert.deepEqual(JSON.parse(text(dup)), { error: "name が既に使われている: dup" });
  const bad = await client.callTool({ name: "session_update", arguments: { name: "pm1", newName: "a b" } }).catch((e: unknown) => e);
  assert.ok(bad instanceof Error || (bad as { isError?: boolean }).isError === true);
  assert.equal(seen.length, 3);
  await close();
});

test("remote_send / remote_create（別名）: owner は session の認証済み名で固定。同じ処理・同じ入力 { server, model?, prompt }。引数 owner は受けない。返り値は送った事だけ", async () => {
  const { session, calls, close } = await connect();
  const c = await session("pm1");
  const ok = await c.callTool({ name: "remote_send", arguments: { server: "srv-a", prompt: "go" } });
  assert.deepEqual(JSON.parse(text(ok)), { remote_id: "pm1-cap", server: "srv-a", model: "sonnet", sent: true });
  const alias = await c.callTool({ name: "remote_create", arguments: { server: "srv-a", prompt: "go2", model: "opus" } });
  assert.equal(alias.isError, undefined);
  // 自己申告の owner は schema に無いので、渡しても無視される
  await c.callTool({ name: "remote_send", arguments: { server: "srv-b", prompt: "go3", model: "claude-sonnet-5-5", owner: "evil" } });
  assert.deepEqual(calls, [
    { remoteSend: { owner: "pm1", server: "srv-a", prompt: "go" } },
    { remoteSend: { owner: "pm1", server: "srv-a", prompt: "go2", model: "opus" } },
    { remoteSend: { owner: "pm1", server: "srv-b", prompt: "go3", model: "claude-sonnet-5-5" } },
  ]);
  // 旧形式（goal だけ）・server 無し・prompt 無し・形式が不正な model は schema で拒否され、remotes.send は呼ばれない
  assert.equal((await c.callTool({ name: "remote_send", arguments: { goal: "x" } })).isError, true);
  assert.equal((await c.callTool({ name: "remote_send", arguments: { prompt: "x" } })).isError, true, "server は必須");
  assert.equal((await c.callTool({ name: "remote_send", arguments: { server: "srv-a" } })).isError, true, "prompt は必須");
  assert.equal((await c.callTool({ name: "remote_send", arguments: { server: "srv-a", prompt: "x", model: "a b" } })).isError, true);
  assert.equal((await c.callTool({ name: "remote_send", arguments: { server: "srv-a", prompt: "a\0b" } })).isError, true);
  assert.equal(calls.length, 3);
  await c.close();
  await close();
});

test("remote_send の失敗（送れない・範囲外など）は isError + {error}", async () => {
  const { session, close } = await connect({}, { remotes: { send: async () => { throw new Error("launch を送れない"); } } });
  const c = await session("pm1");
  const r = await c.callTool({ name: "remote_send", arguments: { server: "srv-a", prompt: "x" } });
  assert.equal(r.isError, true);
  assert.deepEqual(JSON.parse(text(r)), { error: "launch を送れない" });
  await c.close();
  await close();
});

test("worker_reply: session 向け・外向け（desktop の center_call）とも {server, session_id, order, content?} を remotes.reply へ渡す。order は answer / approve / reject のみ。失敗は isError", async () => {
  const { client, session, calls, close } = await connect(undefined, { remotes: { reply: async (i: unknown) => { calls.push({ reply: i }); if ((i as { content?: string }).content === "boom") throw new Error("送れない"); return { server: "srv-a", session_id: "s-1", order: (i as { order: string }).order, sent: true } as never; } } });
  const c = await session("pm1");
  const r = await c.callTool({ name: "worker_reply", arguments: { server: "srv-a", session_id: "s-1", order: "answer", content: "OK 進めて" } });
  assert.deepEqual(JSON.parse(text(r)), { server: "srv-a", session_id: "s-1", order: "answer", sent: true });
  const o = await client.callTool({ name: "worker_reply", arguments: { server: "srv-a", session_id: "s-1", order: "approve" } });
  assert.equal(o.isError, undefined);
  // session 向けは呼び出し元 session の owner を渡す。外向け（desktop）は渡さない
  assert.deepEqual(calls.slice(0, 2), [{ reply: { owner: "pm1", server: "srv-a", session_id: "s-1", order: "answer", content: "OK 進めて" } }, { reply: { server: "srv-a", session_id: "s-1", order: "approve" } }]);
  assert.equal((await c.callTool({ name: "worker_reply", arguments: { server: "srv-a", session_id: "s-1", order: "maybe" } })).isError, true);
  assert.equal((await c.callTool({ name: "worker_reply", arguments: { server: "srv-a", order: "approve" } })).isError, true, "session_id は必須");
  assert.equal((await c.callTool({ name: "worker_reply", arguments: { session_id: "s-1", order: "approve" } })).isError, true, "server は必須");
  assert.equal((await c.callTool({ name: "worker_reply", arguments: { server: "srv-a", session_id: "", order: "approve" } })).isError, true);
  const e = await c.callTool({ name: "worker_reply", arguments: { server: "srv-a", session_id: "s-1", order: "answer", content: "boom" } });
  assert.equal(e.isError, true);
  assert.match(text(e), /送れない/);
  await c.close();
  await close();
});

test("remote_stop / remote_list: remote_list は session 向けなら自分の owner。remote_stop は呼び出し元 session の owner を渡す（引数 owner は受けない。server は必須）。外向け remote_list は owner 引数で絞る（無ければ全件）。remote_delete は無い", async () => {
  const { client, session, calls, close } = await connect();
  const c = await session("pm1");
  await c.callTool({ name: "remote_list", arguments: {} });
  const s = await c.callTool({ name: "remote_stop", arguments: { server: "srv-a", owner: "evil" } });
  assert.deepEqual(JSON.parse(text(s)), { remote_id: "pm1-cap", server: "srv-a", sent: true, forgotten: true });
  assert.equal((await c.callTool({ name: "remote_stop", arguments: {} })).isError, true, "server は必須");
  await c.callTool({ name: "remote_list", arguments: { include_out_of_scope: true } });
  await client.callTool({ name: "remote_list", arguments: {} });
  await client.callTool({ name: "remote_list", arguments: { owner: "pm1" } });
  assert.deepEqual(calls, [
    { remoteList: { owner: "pm1" } },
    { remoteStop: { owner: "pm1", server: "srv-a" } },
    { remoteList: { owner: "pm1", includeOutOfScope: true } },
    { remoteList: {} }, { remoteList: { owner: "pm1", includeOutOfScope: true } },
  ]);
  assert.ok(!(await c.listTools()).tools.some((t) => t.name === "remote_delete"));
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

test("task_status: session 向けは自分の owner の cap を cap ごとに 1 行で返し、server の版は link の控え（server-info の答え）から出す", async () => {
  const views = [
    { remote_id: "pm1-cap@srv-a", session: "pm1", server: "srv-a", serverName: "srv-a", createdAt: "x", state: "running", owners: ["pm1"], server_label: "srv-a" },
    { remote_id: "pm2-cap@srv-a", session: "pm2", server: "srv-a", serverName: "srv-a", createdAt: "x", state: "running", owners: ["pm2"], server_label: "srv-a" },
  ];
  const { sessionWithLink, calls, close } = await connect({}, { remotes: { list: (f: unknown) => (calls.push({ remoteList: f }), views) as never } });
  const c = await sessionWithLink("pm1", { serverVersionOf: (s: string) => (s === "srv-a" ? "1.2.3" : undefined) });
  const r = JSON.parse(text(await c.callTool({ name: "task_status", arguments: {} }))) as { caps: { remote_id: string; line: string }[]; servers: string[] };
  assert.deepEqual(r.caps.map((x) => x.line), ["pm1-cap@srv-a | 実行中"]);
  assert.deepEqual(r.servers, ["srv-a | server 1.2.3"]);
  assert.deepEqual(calls, [{ remoteList: { owner: "pm1", includeOutOfScope: true } }]);
  const none = JSON.parse(text(await (await sessionWithLink("pm1")).callTool({ name: "task_status", arguments: {} }))) as { servers: string[] };
  assert.deepEqual(none.servers, ["srv-a | server 不明"]);
  await c.close();
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
  assert.deepEqual(JSON.parse(text(await client.callTool({ name: "center_settings_get", arguments: {} }))), { settings: { instructions: "共通" }, launcher: false });
  const u = await client.callTool({ name: "center_settings_update", arguments: { settings: { instructions: null, skills: ["a"] } } });
  assert.deepEqual(JSON.parse(text(u)), { settings: { instructions: "後", skills: ["a"] }, launcher: false });
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
  assert.deepEqual(JSON.parse(text(g)), { called: "get", n: "pm1", settings: {} });
  const u = await client.callTool({ name: "session_settings_update", arguments: { name: "pm1", settings: { instructions: null, skills: ["a"] } } });
  assert.deepEqual(JSON.parse(text(u)), { called: "update", n: "pm1", p: { instructions: null, skills: ["a"] }, settings: {} });
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

test("起動元でない呼び出し元: memory・mcpServers を含む更新（session_create / session の設定 / center 共通の設定。null も）は理由つきの error で断り、manager を呼ばない。読みの応答から除く。含まない更新は通る", async () => {
  const called: string[] = [];
  const stored = { instructions: "i", memory: { type: "http", url: "https://m/mcp", headers: { Authorization: "Bearer MEMSECRET" } }, mcpServers: { s: { command: "npx", env: { K: "MCPSECRET" } } } };
  const { client, close } = await connect({}, {
    sessions: {
      create: async () => (called.push("create"), { name: "x" }) as never,
      getSettings: (n: string) => ({ name: n, settings: stored }),
      updateSettings: async (n: string, p: unknown) => (called.push("update"), { name: n, settings: { ...stored, ...(p as object) } }),
      getCenterSettings: () => ({ settings: stored }),
      updateCenterSettings: async (p) => (called.push("center"), { settings: { ...stored, ...(p as object) } }),
    },
  });
  const okU = await client.callTool({ name: "session_settings_update", arguments: { name: "pm1", settings: { instructions: "j" } } });
  assert.deepEqual(JSON.parse(text(okU)), { name: "pm1", settings: { instructions: "j" } });
  const okC = await client.callTool({ name: "center_settings_update", arguments: { settings: { instructions: "j" } } });
  assert.deepEqual(JSON.parse(text(okC)), { settings: { instructions: "j" }, launcher: false });
  assert.deepEqual(called, ["update", "center"]);
  called.length = 0;
  for (const [key, value] of [
    ["memory", { url: "https://mem.example/mcp", token: "tk-SECRET", agentId: "pm-1" }],
    ["memory", null],
    ["memory", { type: "http", url: "https://m/mcp", headers: { Authorization: "Bearer tk-SECRET" } }],
    ["mcpServers", { h: { type: "http", url: "https://h/mcp", headers: { Authorization: "Bearer tk-SECRET" } } }],
    ["mcpServers", null],
  ] as const) {
    for (const [tool, args] of [
      ["session_settings_update", { name: "pm1", settings: { instructions: "i", [key]: value } }],
      ["center_settings_update", { settings: { instructions: "i", [key]: value } }],
      ["session_create", { name: "pm2", settings: { instructions: "i", [key]: value } }],
    ] as const) {
      const r = await client.callTool({ name: tool, arguments: args }).catch((e: unknown) => e);
      assert.ok(!(r instanceof Error) && (r as { isError?: boolean }).isError === true, tool + key + JSON.stringify(value));
      assert.equal(JSON.parse(text(r as never)).error, CENTER_ONLY_MCP_ERROR);
      assert.ok(!text(r as never).includes("SECRET"));
    }
  }
  assert.deepEqual(called, []);
  // 読みの応答から除く（値は出さない）
  const g = text(await client.callTool({ name: "session_settings_get", arguments: { name: "pm1" } }));
  assert.deepEqual(JSON.parse(g), { name: "pm1", settings: { instructions: "i" } });
  const c = text(await client.callTool({ name: "center_settings_get", arguments: {} }));
  assert.deepEqual(JSON.parse(c), { settings: { instructions: "i" }, launcher: false });
  assert.ok(!g.includes("SECRET") && !c.includes("SECRET"));
  const tools = (await client.listTools()).tools;
  for (const n of ["session_settings_get", "session_settings_update", "center_settings_get", "center_settings_update"]) {
    const d = tools.find((t) => t.name === n)?.description ?? "";
    assert.ok(!d.includes("BANTOU_MEMORY_TOKEN") && !d.includes("tokenSet"), n);
  }
  await close();
});

test("起動元（center を起動した所）: memory・mcpServers を含む更新（session_create / session の設定 / center 共通の設定）は manager に渡り、読みの応答にも出る（Bearer の値もそのまま）。旧設定の項目は断る", async () => {
  const seen: unknown[] = [];
  const mem = { type: "http", url: "https://m/mcp", headers: { Authorization: "Bearer MEMV" } };
  const servers = { s: { command: "npx", args: ["-y", "pkg"], env: { K: "V1" } }, h: { type: "http", url: "https://h/mcp", headers: { Authorization: "Bearer HV" } } };
  const { client, close } = await connect({}, {
    launcher: true,
    sessions: {
      create: async (i: unknown) => (seen.push(["create", i]), { name: "pm2" }) as never,
      getSettings: (n: string) => ({ name: n, settings: { memory: mem, mcpServers: servers } }),
      updateSettings: async (n: string, p: unknown) => (seen.push(["update", n, p]), { name: n, settings: p as never }),
      getCenterSettings: () => ({ settings: { memory: mem, mcpServers: servers } }),
      updateCenterSettings: async (p) => (seen.push(["center", p]), { settings: p as never }),
    },
  });
  const u = await client.callTool({ name: "session_settings_update", arguments: { name: "pm1", settings: { memory: mem, mcpServers: servers } } });
  assert.deepEqual(JSON.parse(text(u)), { name: "pm1", settings: { memory: mem, mcpServers: servers } });
  const cu = await client.callTool({ name: "center_settings_update", arguments: { settings: { memory: null, mcpServers: servers } } });
  assert.deepEqual(JSON.parse(text(cu)), { settings: { memory: null, mcpServers: servers }, launcher: true });
  const cr = await client.callTool({ name: "session_create", arguments: { name: "pm2", settings: { mcpServers: servers } } });
  assert.notEqual(cr.isError, true);
  assert.deepEqual(seen, [
    ["update", "pm1", { memory: mem, mcpServers: servers }],
    ["center", { memory: null, mcpServers: servers }],
    ["create", { name: "pm2", settings: { mcpServers: servers } }],
  ]);
  assert.deepEqual(JSON.parse(text(await client.callTool({ name: "session_settings_get", arguments: { name: "pm1" } }))), { name: "pm1", settings: { memory: mem, mcpServers: servers } });
  assert.deepEqual(JSON.parse(text(await client.callTool({ name: "center_settings_get", arguments: {} }))), { settings: { memory: mem, mcpServers: servers }, launcher: true });
  for (const k of ["mcp", "mcpConnections", "mcpSecrets", "coordinator"]) {
    const r = await client.callTool({ name: "center_settings_update", arguments: { settings: { [k]: { session: "pm1" } } } });
    assert.equal(r.isError, true, k);
    assert.equal(JSON.parse(text(r)).error, LEGACY_KEYS_ERROR, k);
  }
  assert.equal(seen.length, 3);
  await close();
});

test("session_login / session_login_code は LoginFlow に委譲。ok: false は isError、LoginFlow が無ければ isError", async () => {
  const calls: unknown[] = [];
  const login: LoginFlow = {
    start: async (name) => (calls.push(["start", name]), { name, loginUrl: "https://claude.com/cai/oauth/authorize?x=1" }),
    code: async (name, code) =>
      code === "bad#s"
        ? { name, ok: false, auth: "login_required", error: "Invalid code" }
        : (calls.push(["code", name, code]), { name, ok: true, auth: "ok", error: null }),
  };
  const { client, close } = await connect({}, { login });
  const started = await client.callTool({ name: "session_login", arguments: { name: "pm1" } });
  assert.equal(started.isError, undefined);
  assert.deepEqual(JSON.parse(text(started)), { name: "pm1", loginUrl: "https://claude.com/cai/oauth/authorize?x=1" });
  const ok = await client.callTool({ name: "session_login_code", arguments: { name: "pm1", code: "AbC123#state_-" } });
  assert.equal(ok.isError, undefined);
  assert.deepEqual(JSON.parse(text(ok)), { name: "pm1", ok: true, auth: "ok", error: null });
  const bad = await client.callTool({ name: "session_login_code", arguments: { name: "pm1", code: "bad#s" } });
  assert.equal(bad.isError, true);
  assert.deepEqual(JSON.parse(text(bad)), { name: "pm1", ok: false, auth: "login_required", error: "Invalid code" });
  // code の形式違い（空白）は schema で弾かれる
  const malformed = await client.callTool({ name: "session_login_code", arguments: { name: "pm1", code: "a b" } }).catch((e: unknown) => e);
  assert.ok(malformed instanceof Error || (malformed as { isError?: boolean }).isError === true);
  assert.deepEqual(calls, [["start", "pm1"], ["code", "pm1", "AbC123#state_-"]]);
  await close();

  const none = await connect();
  const r = await none.client.callTool({ name: "session_login", arguments: { name: "pm1" } });
  assert.equal(r.isError, true);
  assert.deepEqual(JSON.parse(text(r)), { error: "再ログインは使えない（pty 入力が無い）" });
  await none.close();
});

test("rc_start: resume: true は supervisor.start に resume を渡し、無ければ渡さない", async () => {
  const seen: unknown[] = [];
  const { client, close } = await connect({}, {});
  // connect の supervisor は固定なので、呼び出しの引数は別の server で確かめる
  await close();
  const supervisor = {
    start: async (p: string, o?: { resume?: boolean }) => (seen.push([p, o]), rc(p)),
    stop: async (p: string) => rc(p),
    status: (p: string) => rc(p),
    list: () => [],
    shutdown: async () => {},
  } as unknown as RemoteControlSupervisor;
  const server = createCenterServer({
    config: parseConfig({}, "/x/c.json"), supervisor, link: {} as ServerLink, sessions: { list: () => [] } as unknown as SessionManager, remotes: {} as RemoteManager,
  });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const c = new Client({ name: "t", version: "0" });
  await Promise.all([server.connect(st), c.connect(ct)]);
  await c.callTool({ name: "rc_start", arguments: { project: "p" } });
  await c.callTool({ name: "rc_start", arguments: { project: "p", resume: true } });
  await c.callTool({ name: "rc_start", arguments: { project: "p", resume: false } });
  assert.deepEqual(seen, [["p", {}], ["p", { resume: true }], ["p", {}]]);
  await c.close();
});

test("session_sleep / session_wake は SessionManager へ名前を委譲し、例外は isError。不正な名前は弾く", async () => {
  const seen: string[] = [];
  const { client, close } = await connect({}, {
    sessions: {
      sleep: async (n) => { seen.push(`sleep:${n}`); if (n === "cfg") throw new Error("session_create で作ったものではない（config 由来）: cfg"); return { name: n, state: "stopped", sleeping: true } as never; },
      wake: async (n) => { seen.push(`wake:${n}`); return { name: n, state: "connected", sleeping: false } as never; },
    },
  });
  assert.deepEqual(JSON.parse(text(await client.callTool({ name: "session_sleep", arguments: { name: "pm1" } }))), { name: "pm1", state: "stopped", sleeping: true });
  assert.deepEqual(JSON.parse(text(await client.callTool({ name: "session_wake", arguments: { name: "pm1" } }))), { name: "pm1", state: "connected", sleeping: false });
  const cfg = await client.callTool({ name: "session_sleep", arguments: { name: "cfg" } });
  assert.equal(cfg.isError, true);
  assert.match(text(cfg), /config 由来/);
  const bad = await client.callTool({ name: "session_sleep", arguments: { name: "a b" } }).catch((e: unknown) => e);
  assert.ok(bad instanceof Error || (bad as { isError?: boolean }).isError === true);
  assert.deepEqual(seen, ["sleep:pm1", "wake:pm1", "sleep:cfg"]);
  await close();
});

test("T12: session_sleep は resession.requestSleep（引継ぎを書かせてから眠らせる）を呼び、受理の形（accepted / pending）をそのまま返す。拒否は isError で理由を返す。sessions.sleep は直接呼ばない", async () => {
  const seen: string[] = [];
  let direct = 0;
  const { client, close } = await connect({}, {
    sessions: { sleep: async () => { direct++; return {} as never; } },
    resession: {
      requestSleep: async (n) => {
        seen.push(`req:${n}`);
        if (n === "busy") throw new Error("利用者の入力待ち（needs-input）の間はリセッションしない");
        return { name: n, state: "connected", accepted: true, sleeping: false, pending: true } as never;
      },
    },
  });
  assert.deepEqual(JSON.parse(text(await client.callTool({ name: "session_sleep", arguments: { name: "pm1" } }))), { name: "pm1", state: "connected", accepted: true, sleeping: false, pending: true });
  const busy = await client.callTool({ name: "session_sleep", arguments: { name: "busy" } });
  assert.equal(busy.isError, true);
  assert.match(text(busy), /needs-input/);
  assert.deepEqual(seen, ["req:pm1", "req:busy"]);
  assert.equal(direct, 0);
  await close();
});

test("T12: session_sleep・session_wake の description は「元の会話のまま」を含まず、引継ぎ・新しい会話・状況確認の入力が無い事を書く", async () => {
  const { client, close } = await connect();
  const tools = (await client.listTools()).tools;
  const sleepD = tools.find((t) => t.name === "session_sleep")!.description ?? "";
  const wakeD = tools.find((t) => t.name === "session_wake")!.description ?? "";
  for (const d of [sleepD, wakeD]) {
    assert.ok(!d.includes("元の会話のまま"), d);
    assert.ok(d.includes("新しい会話") && d.includes("引継ぎ"), d);
  }
  assert.ok(sleepD.includes("session_resession") && sleepD.includes("accepted") && sleepD.includes("pending"));
  assert.ok(wakeD.includes("状況確認の別の入力は送らない"));
  await close();
});

test("rc_start: スリープ中の session は supervisor.start ではなく wake（元の会話で起こす）", async () => {
  const woken: string[] = [];
  const started: string[] = [];
  const supervisor = { start: async (p: string) => (started.push(p), rc(p)), list: () => [] } as unknown as RemoteControlSupervisor;
  const sessions = { list: () => [{ name: "zzz", sleeping: true }, { name: "awake", sleeping: false }], wake: async (n: string) => (woken.push(n), { name: n, sleeping: false }) } as unknown as SessionManager;
  const server = createCenterServer({ config: parseConfig({}, "/x/c.json"), supervisor, link: {} as ServerLink, sessions, remotes: {} as RemoteManager });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const c = new Client({ name: "t", version: "0" });
  await Promise.all([server.connect(st), c.connect(ct)]);
  await c.callTool({ name: "rc_start", arguments: { project: "zzz" } });
  await c.callTool({ name: "rc_start", arguments: { project: "awake" } });
  assert.deepEqual(woken, ["zzz"]);
  assert.deepEqual(started, ["awake"]);
  await c.close();
});
