import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer as createNetServer } from "node:net";
import { z } from "zod";
import { buildSessionBrief, SESSION_BRIEF_LINE_MAX, SESSION_BRIEF_MAX_CHARS, SESSION_BRIEF_MAX_LINES, type CoordinatorDeps } from "../src/coordinator.js";
import {
  bearerIs, centerBackend, centerHostOf, CENTER_TOKEN_ENV, coordinatorEntry, COORDINATOR_MCP_FILE, COORDINATOR_MCP_PATH, ensureCoordinatorState, isCoordinatorEntry, startCoordinatorChild, startCoordinatorHttp,
} from "../src/coordinator-mcp.js";
import { createCore } from "../src/core.js";
import { createEventHub } from "../src/events.js";
import { startHttpServer } from "../src/http.js";
import { assertCenterOnly, readCenterSettings, readCoordinator } from "../src/project-settings.js";
import type { RemoteManager } from "../src/remotes.js";
import { createSessionMcpServer } from "../src/server.js";
import { createSessionTokens } from "../src/session-auth.js";
import type { SessionInfo } from "../src/sessions.js";
import { applicableParts, buildSystemInstructions, partLabel } from "../src/system-instructions.js";

const NOW = Date.parse("2026-01-01T01:00:00Z");
const iso = (minAgo: number): string => new Date(NOW - minAgo * 60_000).toISOString();

const info = (name: string, extra: Partial<SessionInfo> = {}): SessionInfo => ({
  name, path: "/secret/path", state: "connected", sleeping: false, pid: 1, sessionUrl: "https://secret.example/s", startedAt: iso(30), source: "session",
  lastError: "SECRET-ERROR", contextUsage: { usedTokens: 1, windowTokens: 10, percent: 42.4, updatedAt: iso(1) },
  activity: "working", activityAt: iso(7), remote: { running: 1, waitingReply: 0 }, instructions: true, auth: "ok" as SessionInfo["auth"], loginUrl: null, loginError: null, ...extra,
});

const text = (r: unknown): string => ((r as { content: { text: string }[] }).content[0]?.text ?? "");
const isError = (r: unknown): boolean => (r as { isError?: boolean }).isError === true;

// ---- 設定の検査 ----

test("coordinator: 旧設定の coordinator は center 共通の設定として読まない・受けない（割り当てが正本）", () => {
  assert.ok(!("coordinator" in readCenterSettings({ coordinator: { session: "main" }, instructions: "x" })));
  assert.equal(readCenterSettings({ coordinator: { session: "main" }, instructions: "x" }).instructions, "x");
  // 旧設定の値を取り出せるのは移行だけ（readCoordinator）。壊れた値は null
  assert.equal(readCoordinator({ session: "main" }), "main");
  assert.equal(readCoordinator({ session: "bad name" }), null);
  assert.equal(readCoordinator(undefined), null);
  // 設定の更新の入力は旧設定の項目として誰からも断る（assertCenterOnly。起動元でも）
  assert.throws(() => assertCenterOnly({ coordinator: { session: "main" } }), /center を起動した所/);
  assert.throws(() => assertCenterOnly({ coordinator: null }), /center を起動した所/);
  assert.throws(() => assertCenterOnly({ coordinator: { session: "main" } }, { launcher: true }), /旧設定の項目/);
});

// ---- 指示文の部品 ----

test("部品 coordinator: 統括の MCP の server を設定に書いた session だけに付く。未設定の時の指示文は今と同じ（部品が増えない）", () => {
  const plain = { session: "a", memory: false };
  assert.deepEqual(applicableParts(plain).map(partLabel), ["base-spec@1", "master-cap-role@6", "master-cap-availability@2"]);
  assert.deepEqual(applicableParts({ ...plain, coordinator: false }).map(partLabel), ["base-spec@1", "master-cap-role@6", "master-cap-availability@2"]);
  assert.equal(buildSystemInstructions({ ...plain, coordinator: false }), buildSystemInstructions(plain));
  const co = buildSystemInstructions({ ...plain, coordinator: true });
  assert.deepEqual(applicableParts({ ...plain, coordinator: true }).map(partLabel), ["base-spec@1", "master-cap-role@6", "master-cap-availability@2", "coordinator@4"]);
  assert.ok(co.startsWith(buildSystemInstructions(plain)));
  // 文面はその時点で出す道具（session_brief と coordinator_session_create）だけ。まだ無い道具の名前は出ない
  assert.match(co, /session_brief/);
  assert.match(co, /coordinator_session_create/);
  for (const absent of ["session_dispatch", "session_prompts"]) assert.ok(!co.includes(absent), absent);
  assert.match(co, /include_shared/);
  assert.match(co, /Read しない/);
});

// ---- session_brief の 1 行 ----

test("session_brief: 1 行は件数だけ。本文・path・URL・error の文は入らない。activity が unknown なら時刻の分を出さない", () => {
  const r = buildSessionBrief([info("alpha"), info("beta", { activity: "unknown", activityAt: null, state: "stopped", contextUsage: null, remote: { running: 0, waitingReply: 2, unreachable: [{ server: "SECRET-SERVER", remoteId: "r" }], lost: [{ server: "s", remoteId: "r2" }, { server: "s", remoteId: "r3" }] } })], "main", NOW);
  assert.equal(r.sessions[0]!.line, "alpha | 接続 | working 7 分 | ctx 42% | remote 実行中 1・返答待ち 0・到達不能 0・lost 0");
  assert.equal(r.sessions[1]!.line, "beta | 停止 | 作業状態 不明 | ctx ? | remote 実行中 0・返答待ち 2・到達不能 1・lost 2");
  const all = JSON.stringify(r);
  for (const s of ["SECRET", "/secret", "https://"]) assert.ok(!all.includes(s), s);
  assert.equal(r.truncated, false);
  assert.equal(buildSessionBrief([info("alpha"), info("beta")], "main", NOW, { session: "beta" }).sessions.length, 1);
});

test("道具の説明: session_brief の説明に、出ない自分の行の警告を書かない（owner は渡さない）", async () => {
  const h = await startCoordinatorHttp({ port: 0, key: "k".repeat(40), backend: { sessions: async () => [], createSession: async () => ({ name: "x", state: "" }), sleepSession: async (n) => ({ name: n, state: "stopped", sleeping: true }) } });
  try {
    const c = new Client({ name: "t", version: "0" });
    await c.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${h.port}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${"k".repeat(40)}` } } }));
    const tools = (await c.listTools()).tools;
    const brief = tools.find((t) => t.name === "session_brief")!;
    assert.ok(!brief.description!.includes("警告"));
    await c.close();
  } finally {
    await h.close();
  }
});

test("session_brief: 統括の自分の行だけ、作業が多い時に警告が付く", () => {
  const busy = { running: 2, waitingReply: 0 };
  const r = buildSessionBrief([info("main", { remote: busy }), info("other", { remote: busy }), info("main2", { remote: { running: 0, waitingReply: 1 } })], "main", NOW);
  assert.match(r.sessions[0]!.line, /警告: 自分の project の作業が多い（remote 実行中 2・返答待ち 0）/);
  assert.ok(!r.sessions[1]!.line.includes("警告"));
  assert.ok(!r.sessions[2]!.line.includes("警告"));
  assert.match(buildSessionBrief([info("main", { remote: { running: 0, waitingReply: 1 } })], "main", NOW).sessions[0]!.line, /警告/);
  assert.ok(!buildSessionBrief([info("main", { remote: { running: 1, waitingReply: 0 } })], "main", NOW).sessions[0]!.line.includes("警告"));
});

test("session_brief: 1 行 200 文字・40 行・6000 文字の上限。越えたら truncated と omitted", () => {
  const many = Array.from({ length: SESSION_BRIEF_MAX_LINES + 7 }, (_, i) => info(`s${i}`));
  const r = buildSessionBrief(many, "x", NOW);
  assert.equal(r.sessions.length, SESSION_BRIEF_MAX_LINES);
  assert.equal(r.truncated, true);
  assert.equal(r.omitted, 7);
  const longName = Array.from({ length: 40 }, (_, i) => info(`${"n".repeat(150)}${i}`, { remote: { running: 9, waitingReply: 9 } }));
  const r2 = buildSessionBrief(longName, "n".repeat(150) + "0", NOW);
  assert.ok(r2.sessions.every((s) => s.line.length <= SESSION_BRIEF_LINE_MAX));
  assert.ok(r2.sessions.reduce((n, s) => n + s.line.length, 0) <= SESSION_BRIEF_MAX_CHARS);
  assert.ok(r2.truncated && r2.omitted > 0);
  // 返り値全体（整形ありの JSON。name の二重を含む）でも 6000 文字以内
  assert.ok(JSON.stringify(r2, null, 2).length <= SESSION_BRIEF_MAX_CHARS);
  for (const n of [1, 30, 64]) {
    const rs = buildSessionBrief(Array.from({ length: SESSION_BRIEF_MAX_LINES }, (_, i) => info(`${"m".repeat(n)}${i}`)), "x", NOW);
    assert.ok(JSON.stringify(rs, null, 2).length <= SESSION_BRIEF_MAX_CHARS, `name ${n}`);
    assert.equal(rs.sessions.length + rs.omitted, SESSION_BRIEF_MAX_LINES);
  }
});

// ---- 統括の MCP の server（coordinator-mcp.ts。独立した http の server） ----

const KEY = "k".repeat(40);
type Backend = Pick<CoordinatorDeps, "sessions" | "createSession" | "sleepSession">;
const fakeBackend = (over: Partial<Backend> = {}, created: string[] = []): Backend => ({
  sessions: async () => [info("main"), info("other")],
  createSession: async (i) => {
    created.push(i.name);
    return { name: i.name, state: i.start ? "connected" : "stopped" };
  },
  sleepSession: async (name) => ({ name, state: "stopped", sleeping: true }),
  ...over,
});

async function boot(backend: Backend = fakeBackend(), logs: string[] = []) {
  const h = await startCoordinatorHttp({ port: 0, key: KEY, backend, log: (m) => logs.push(m), now: () => NOW });
  const url = `http://127.0.0.1:${h.port}${COORDINATOR_MCP_PATH}`;
  // 設定の 1 項目（type: http・url・headers）と同じ形で繋ぐ
  const connect = async (headers: Record<string, string> = { Authorization: `Bearer ${KEY}` }): Promise<Client> => {
    const c = new Client({ name: "t", version: "0" });
    await c.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers } }));
    return c;
  };
  return { h, url, connect, logs };
}
const names = async (c: Client): Promise<string[]> => (await c.listTools()).tools.map((t) => t.name).sort();

test("統括の server: 設定の 1 項目（url・Authorization）で initialize・tools/list・tools/call が通り、道具は 3 つだけ", async () => {
  const { h, connect } = await boot();
  try {
    const c = await connect();
    assert.deepEqual(await names(c), ["coordinator_session_create", "coordinator_session_sleep", "session_brief"]);
    const r = JSON.parse(text(await c.callTool({ name: "session_brief", arguments: {} }))) as { sessions: { name: string; line: string }[] };
    assert.deepEqual(r.sessions.map((s) => s.name), ["main", "other"]);
    assert.ok(!text(await c.callTool({ name: "session_brief", arguments: {} })).includes("SECRET"));
    const one = JSON.parse(text(await c.callTool({ name: "session_brief", arguments: { session: "other" } }))) as { sessions: unknown[] };
    assert.equal(one.sessions.length, 1);
    assert.ok(isError(await c.callTool({ name: "session_brief", arguments: { session: "nope" } })));
  } finally {
    await h.close();
  }
});

test("統括の server: Authorization が無い・違う・形が違う呼び手は 401 で、道具の一覧も出ない。Host・path・method も確かめる", async () => {
  const { h, url, connect } = await boot();
  try {
    for (const headers of [{}, { Authorization: "Bearer wrong" }, { Authorization: KEY }, { Authorization: `bearer ${KEY}` }, { Authorization: `Bearer ${KEY}x` }]) {
      await assert.rejects(connect(headers), /401|nauthorized/, JSON.stringify(headers));
    }
    const post = (u: string, init: RequestInit) => fetch(u, { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }), ...init, headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(init.headers as Record<string, string>) } });
    const ok = { Authorization: `Bearer ${KEY}` };
    assert.equal((await post(url, { headers: {} })).status, 401);
    assert.equal((await post(url.replace("/mcp", "/other"), { headers: ok })).status, 404);
    assert.equal((await fetch(url, { headers: ok })).status, 405);
    const hostStatus = await new Promise<number | undefined>((resolve, reject) => {
      const rq = httpRequest(url, { method: "POST", headers: { ...ok, Host: "evil.example", "content-type": "application/json", accept: "application/json, text/event-stream" } }, (r) => (r.resume(), resolve(r.statusCode)));
      rq.on("error", reject);
      rq.end("{}");
    });
    assert.equal(hostStatus, 403);
    assert.equal((await post(url, { headers: ok })).status, 200);
  } finally {
    await h.close();
  }
});

test("統括の server: 設定に書いていない session（key を持たない）は使えない。key は center の他の token と別物", async () => {
  const { h, connect } = await boot();
  try {
    // 別の session の token・center の token を持っていても通らない
    for (const tok of ["session-token-0123456789abcdef", "center-token-0123456789abcdef0123"]) await assert.rejects(connect({ Authorization: `Bearer ${tok}` }), /401|nauthorized/);
    await connect();
  } finally {
    await h.close();
  }
});

test("coordinator_session_create: center へ name・start・instructions を渡す。path は渡せない。start 省略は起動する", async () => {
  const seen: unknown[] = [];
  const { h, connect } = await boot(fakeBackend({ createSession: async (i) => (seen.push(i), { name: i.name, state: "connected" }) }));
  try {
    const c = await connect();
    const r = await c.callTool({ name: "coordinator_session_create", arguments: { name: "proj-1", instructions: "最初の説明", path: "/etc/evil" } });
    assert.ok(!isError(r), text(r));
    assert.deepEqual(JSON.parse(text(r)), { name: "proj-1", state: "connected" });
    assert.deepEqual(seen, [{ name: "proj-1", instructions: "最初の説明", start: true }]);
    await c.callTool({ name: "coordinator_session_create", arguments: { name: "idle-1", start: false } });
    assert.deepEqual(seen[1], { name: "idle-1", start: false });
  } finally {
    await h.close();
  }
});

test("coordinator_session_create: 形の崩れた名前・65 文字は center へ渡る前に断る", async () => {
  const created: string[] = [];
  const { h, connect } = await boot(fakeBackend({}, created));
  try {
    const c = await connect();
    for (const bad of ["..", ".", "../x", "a/b", "/abs", "a b", "", "a\\b", "x/../../y", "n".repeat(65)]) {
      assert.ok(isError(await c.callTool({ name: "coordinator_session_create", arguments: { name: bad } })), bad);
    }
    assert.deepEqual(created, []);
    assert.ok(!isError(await c.callTool({ name: "coordinator_session_create", arguments: { name: "n".repeat(64), start: false } })));
    assert.equal(created.length, 1);
  } finally {
    await h.close();
  }
});

test("coordinator_session_create / session_brief: 失敗の文に path・別 project の名前・center の詳細が出ない（log にだけ残す）。同名は文を返す", async () => {
  const logs: string[] = [];
  const backend = fakeBackend({
    sessions: async () => {
      throw new Error("ECONNREFUSED /secret/path secret-owner");
    },
    createSession: async (i) => {
      throw new Error(i.name === "dup" ? "name が既に使われている: dup" : `path の衝突: /secret/ws/${i.name} secret-owner EEXIST`);
    },
  });
  const { h, connect } = await boot(backend, logs);
  try {
    const c = await connect();
    const dup = await c.callTool({ name: "coordinator_session_create", arguments: { name: "dup" } });
    assert.ok(isError(dup));
    assert.match(text(dup), /name が既に使われている: dup/);
    const bad = await c.callTool({ name: "coordinator_session_create", arguments: { name: "target" } });
    assert.ok(isError(bad));
    for (const leak of ["/secret", "secret-owner", "EEXIST"]) assert.ok(!text(bad).includes(leak), leak);
    assert.ok(logs.some((l) => l.includes("secret-owner") && l.includes("target")));
    const brief = await c.callTool({ name: "session_brief", arguments: {} });
    assert.ok(isError(brief));
    for (const leak of ["/secret", "secret-owner", "ECONNREFUSED"]) assert.ok(!text(brief).includes(leak), leak);
  } finally {
    await h.close();
  }
});

// ---- center への経路（centerBackend） ----

test("centerBackend: center の /mcp（token）の session_list・session_create を呼ぶ。path は渡さない。center の error は throw", async () => {
  const calls: { name: string; args: unknown; auth: string | undefined }[] = [];
  let lastAuth: string | undefined;
  const makeServer = (): McpServer => {
    const s = new McpServer({ name: "fake-center", version: "0" });
    s.registerTool("session_list", { description: "x" }, async () => (calls.push({ name: "session_list", args: {}, auth: lastAuth }), { content: [{ type: "text", text: JSON.stringify([info("main")]) }] }));
    s.registerTool("session_create", { description: "x", inputSchema: { name: z.string(), start: z.boolean().optional(), settings: z.object({ instructions: z.string().optional() }).optional(), path: z.string().optional() } }, async (a) => {
      calls.push({ name: "session_create", args: a, auth: lastAuth });
      if (a.name === "dup") return { content: [{ type: "text" as const, text: JSON.stringify({ error: "name が既に使われている: dup" }) }], isError: true };
      return { content: [{ type: "text" as const, text: JSON.stringify({ name: a.name, state: "connected" }) }] };
    });
    return s;
  };
  const tokens = createSessionTokens();
  const h = await startHttpServer({
    createServer: () => makeServer(),
    createSessionServer: (owner) => createSessionMcpServer({ remotes: {} as RemoteManager, owner }),
    sessionAuth: tokens,
    core: createCore(),
    events: createEventHub(),
    port: 0,
    log: () => {},
    bind: "127.0.0.1",
    token: "center-token-0123456789abcdef0123",
  });
  try {
    lastAuth = "Bearer center-token-0123456789abcdef0123";
    const b = centerBackend({ url: `http://127.0.0.1:${h.port}/mcp`, token: "center-token-0123456789abcdef0123" });
    assert.deepEqual((await b.sessions()).map((s) => s.name), ["main"]);
    assert.deepEqual(await b.createSession({ name: "p1", start: true, instructions: "i" }), { name: "p1", state: "connected" });
    assert.deepEqual(calls[1]!.args, { name: "p1", start: true, settings: { instructions: "i" } });
    await assert.rejects(b.createSession({ name: "dup", start: true }), /name が既に使われている: dup/);
    // token が違えば center が断る
    await assert.rejects(centerBackend({ url: `http://127.0.0.1:${h.port}/mcp`, token: "wrong-token-0123456789abcdefghij" }).sessions());
  } finally {
    await h.close();
  }
});

test("centerBackend: 呼ぶたびに center の MCP session を閉じる（DELETE）。上限（32）を越える回数を呼んでも center の initialize は断られない", async () => {
  const makeServer = (): McpServer => {
    const s = new McpServer({ name: "fake-center", version: "0" });
    s.registerTool("session_list", { description: "x" }, async () => ({ content: [{ type: "text", text: JSON.stringify([info("main")]) }] }));
    return s;
  };
  const h = await startHttpServer({
    createServer: () => makeServer(),
    createSessionServer: (owner) => createSessionMcpServer({ remotes: {} as RemoteManager, owner }),
    sessionAuth: createSessionTokens(),
    core: createCore(),
    events: createEventHub(),
    port: 0,
    log: () => {},
    bind: "127.0.0.1",
    token: "center-token-0123456789abcdef0123",
  });
  try {
    const b = centerBackend({ url: `http://127.0.0.1:${h.port}/mcp`, token: "center-token-0123456789abcdef0123" });
    for (let i = 0; i < 40; i++) assert.deepEqual((await b.sessions()).map((s) => s.name), ["main"], `call ${i}`);
  } finally {
    await h.close();
  }
});

// ---- 状態（port・key）と設定の 1 項目 ----

test("ensureCoordinatorState: 初回に作り（0600）、以後は同じ port・key を返す（url が起動のたびに変わらない）。不正なら作り直さず止まる", async () => {
  const dir = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "coord-state-"));
  try {
    const a = await ensureCoordinatorState(dir);
    assert.ok(Number.isInteger(a.port) && a.port >= 1 && a.port <= 65535);
    assert.ok(a.key.length >= 32);
    assert.equal((await stat(join(dir, COORDINATOR_MCP_FILE))).mode & 0o777, 0o600);
    assert.deepEqual(await ensureCoordinatorState(dir), a);
    assert.deepEqual(await readdir(dir), [COORDINATOR_MCP_FILE]);
    const e = coordinatorEntry(a);
    assert.deepEqual(Object.keys(e).sort(), ["headers", "type", "url"]);
    assert.equal(e.type, "http");
    assert.equal(e.url, `http://127.0.0.1:${a.port}/mcp`);
    assert.deepEqual(e.headers, { Authorization: `Bearer ${a.key}` });
    assert.ok(isCoordinatorEntry(e, a));
    await writeFile(join(dir, COORDINATOR_MCP_FILE), JSON.stringify({ port: 0, key: "short" }));
    await assert.rejects(ensureCoordinatorState(dir), /不正/);
    assert.equal(JSON.parse(await readFile(join(dir, COORDINATOR_MCP_FILE), "utf8")).key, "short");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("ensureCoordinatorState: 初回は空き port を選ぶ。同じ host の 2 台目の状態 dir は、1 台目が使っている port を取らない", async () => {
  const d1 = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "coord-state-"));
  const d2 = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "coord-state-"));
  const holder = createNetServer();
  try {
    const a = await ensureCoordinatorState(d1);
    await new Promise<void>((resolve, reject) => (holder.once("error", reject), holder.listen(a.port, "127.0.0.1", resolve)));
    const b = await ensureCoordinatorState(d2);
    assert.notEqual(b.port, a.port);
    assert.notEqual(b.key, a.key);
    // 書いた後は変わらない（1 台目が止まって port が空いても）
    await new Promise<void>((resolve) => holder.close(() => resolve()));
    assert.deepEqual(await ensureCoordinatorState(d2), b);
  } finally {
    if (holder.listening) await new Promise<void>((resolve) => holder.close(() => resolve()));
    await rm(d1, { recursive: true, force: true });
    await rm(d2, { recursive: true, force: true });
  }
});

test("centerHostOf: 同じ host の子が center へ繋ぐ host。全部受ける bind・localhost は 127.0.0.1、IPv6 は [ ] で囲む、それ以外は bind のまま", () => {
  for (const b of ["", "0.0.0.0", "::", "localhost"]) assert.equal(centerHostOf(b), "127.0.0.1", b);
  assert.equal(centerHostOf("::1"), "[::1]");
  assert.equal(centerHostOf("[::1]"), "[::1]");
  assert.equal(centerHostOf("127.0.0.1"), "127.0.0.1");
  assert.equal(centerHostOf("192.168.1.5"), "192.168.1.5");
});

test("isCoordinatorEntry: url が統括の server（127.0.0.1 か localhost・port・/mcp）の http の項目だけ。他の server・stdio は違う", () => {
  const st = { port: 7911 };
  assert.ok(isCoordinatorEntry({ type: "http", url: "http://127.0.0.1:7911/mcp" }, st));
  assert.ok(isCoordinatorEntry({ url: "http://localhost:7911/mcp", headers: {} }, st));
  for (const bad of [{ type: "http", url: "http://127.0.0.1:7912/mcp" }, { type: "http", url: "http://127.0.0.1:7911/other" }, { type: "http", url: "https://127.0.0.1:7911/mcp" }, { type: "http", url: "http://example.com:7911/mcp" }, { type: "sse", url: "http://127.0.0.1:7911/mcp" }, { command: "x" }, null, "x"])
    assert.ok(!isCoordinatorEntry(bad, st), JSON.stringify(bad));
});

test("bearerIs: 一致だけ通す。短い key・Bearer でない header は通さない", () => {
  assert.ok(bearerIs(`Bearer ${KEY}`, KEY));
  assert.ok(!bearerIs(undefined, KEY) && !bearerIs(KEY, KEY) && !bearerIs("Bearer ", KEY) && !bearerIs(`Bearer ${KEY}`, "short") && !bearerIs("Bearer short", "short"));
});

// ---- center による起動 ----

test("startCoordinatorChild: 子に center の token を env で渡し（argv に出さない）、stop で止める。落ちたら再起動する", async () => {
  const dir = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "coord-child-"));
  const logs: string[] = [];
  try {
    const out = join(dir, "out.txt");
    const script = `require("fs").appendFileSync(${JSON.stringify(out)}, (process.env.${CENTER_TOKEN_ENV} ?? "none") + "\\n"); setInterval(()=>{}, 1000)`;
    const child = startCoordinatorChild({ stateDir: dir, centerUrl: "http://127.0.0.1:1/mcp", token: "TOK-123", log: (m) => logs.push(m), command: [process.execPath, "-e", script] });
    for (let i = 0; i < 100 && !existsSync(out); i++) await new Promise((r) => setTimeout(r, 50));
    child.stop();
    assert.equal((await readFile(out, "utf8")).trim(), "TOK-123");
    assert.ok(!logs.join("\n").includes("TOK-123"));
    // 落ちる子: 終了と再起動の予定が log に出る
    const logs2: string[] = [];
    const c2 = startCoordinatorChild({ stateDir: dir, centerUrl: "http://127.0.0.1:1/mcp", token: "T", log: (m) => logs2.push(m), command: [process.execPath, "-e", "process.exit(3)"] });
    for (let i = 0; i < 100 && !logs2.some((l) => l.includes("再起動")); i++) await new Promise((r) => setTimeout(r, 50));
    c2.stop();
    assert.ok(logs2.some((l) => l.includes("code=3") && l.includes("再起動")));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("統括の道具 coordinator_session_sleep: 他の session をスリープさせる（center の session_sleep へ委譲）。未定義の拒否は文を返し、それ以外は一般化して詳細は log だけ", async () => {
  const slept: string[] = [];
  const logs: string[] = [];
  const { h, connect } = await boot(
    fakeBackend({
      sleepSession: async (name) => {
        if (name === "ghost") throw new Error("未定義の session: ghost");
        if (name === "boom") throw new Error("SECRET-DETAIL");
        slept.push(name);
        return { name, state: "stopped", sleeping: true };
      },
    }),
    logs,
  );
  try {
    const c = await connect();
    const ok = await c.callTool({ name: "coordinator_session_sleep", arguments: { name: "other" } });
    assert.equal(isError(ok), false);
    assert.deepEqual(JSON.parse(text(ok)), { name: "other", state: "stopped", sleeping: true });
    assert.deepEqual(slept, ["other"]);
    const ghost = await c.callTool({ name: "coordinator_session_sleep", arguments: { name: "ghost" } });
    assert.equal(isError(ghost), true);
    assert.match(text(ghost), /未定義の session: ghost/);
    const boom = await c.callTool({ name: "coordinator_session_sleep", arguments: { name: "boom" } });
    assert.equal(isError(boom), true);
    assert.doesNotMatch(text(boom), /SECRET-DETAIL/);
    assert.ok(logs.some((l) => l.includes("SECRET-DETAIL")));
    await c.close();
  } finally {
    await h.close();
  }
});

test("統括の道具: key の無い呼び手（統括の server を書いていない session）は 401 で、スリープさせられない", async () => {
  const slept: string[] = [];
  const { h, connect } = await boot(fakeBackend({ sleepSession: async (n) => (slept.push(n), { name: n, state: "stopped", sleeping: true }) }));
  try {
    await assert.rejects(() => connect({}));
    await assert.rejects(() => connect({ Authorization: `Bearer ${"x".repeat(40)}` }));
    assert.deepEqual(slept, []);
  } finally {
    await h.close();
  }
});

test("session_brief: スリープ中の session は状態が「スリープ」と出る（停止とは別）", () => {
  const r = buildSessionBrief([info("a", { state: "stopped", sleeping: true, activity: "unknown", activityAt: null }), info("b", { state: "stopped" })], "", NOW);
  assert.match(r.sessions[0].line, /^a \| スリープ \|/);
  assert.match(r.sessions[1].line, /^b \| 停止 \|/);
});

test("統括の道具 coordinator_session_sleep: 呼んだ session 自身（header X-Bantou-Session）は眠らせず断る。他の session は眠らせられる。header の無い呼び手は誰か分からないので断らない", async () => {
  const slept: string[] = [];
  const { h, connect } = await boot(fakeBackend({ sleepSession: async (name) => (slept.push(name), { name, state: "stopped", sleeping: true }) }));
  try {
    const me = await connect({ Authorization: `Bearer ${KEY}`, "X-Bantou-Session": "main" });
    const self = await me.callTool({ name: "coordinator_session_sleep", arguments: { name: "main" } });
    assert.equal(isError(self), true);
    assert.match(text(self), /自分自身はスリープさせられない/);
    assert.deepEqual(slept, []);
    const other = await me.callTool({ name: "coordinator_session_sleep", arguments: { name: "other" } });
    assert.equal(isError(other), false);
    assert.deepEqual(slept, ["other"]);
    await me.close();
    // header の無い呼び手（center を介さない直接の呼び出し）は誰か分からない
    const anon = await connect();
    const r = await anon.callTool({ name: "coordinator_session_sleep", arguments: { name: "main" } });
    assert.equal(isError(r), false);
    await anon.close();
  } finally {
    await h.close();
  }
});
