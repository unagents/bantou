import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseConfig } from "../src/config.js";
import { createJsonListStore } from "../src/store.js";
import type { RcStatus, RemoteControlSupervisor } from "../src/remote-control.js";
import { createSessionManager, type SavedSession } from "../src/sessions.js";
import { createSessionVia, buildSessionBrief, SESSION_BRIEF_LINE_MAX, SESSION_BRIEF_MAX_CHARS, SESSION_BRIEF_MAX_LINES, type CoordinatorDeps } from "../src/coordinator.js";
import { createCore } from "../src/core.js";
import { createEventHub } from "../src/events.js";
import { startHttpServer } from "../src/http.js";
import { centerSettingsPatchSchema, mergeSettings, readCenterSettings, readCoordinator, type ProjectSettingsPatch } from "../src/project-settings.js";
import type { RemoteManager } from "../src/remotes.js";
import { createSessionMcpServer } from "../src/server.js";
import { createSessionTokens } from "../src/session-auth.js";
import type { SessionInfo } from "../src/sessions.js";
import { applicableParts, buildSystemInstructions, partLabel } from "../src/system-instructions.js";

const NOW = Date.parse("2026-01-01T01:00:00Z");
const iso = (minAgo: number): string => new Date(NOW - minAgo * 60_000).toISOString();

const info = (name: string, extra: Partial<SessionInfo> = {}): SessionInfo => ({
  name, path: "/secret/path", state: "connected", pid: 1, sessionUrl: "https://secret.example/s", startedAt: iso(30), source: "session",
  lastError: "SECRET-ERROR", contextUsage: { usedTokens: 1, windowTokens: 10, percent: 42.4, updatedAt: iso(1) },
  activity: "working", activityAt: iso(7), remote: { running: 1, waitingReply: 0 }, instructions: true, auth: "ok" as SessionInfo["auth"], loginUrl: null, loginError: null, ...extra,
});

const text = (r: unknown): string => ((r as { content: { text: string }[] }).content[0]?.text ?? "");
const isError = (r: unknown): boolean => (r as { isError?: boolean }).isError === true;

// ---- 設定の検査 ----

test("coordinator.session: 不正な値は center 共通の設定の更新で断る。正しい値と null は通る", () => {
  const ok = (v: unknown) => centerSettingsPatchSchema.safeParse({ coordinator: v }).success;
  assert.ok(ok({ session: "main-1_a" }));
  assert.ok(ok(null));
  assert.ok(centerSettingsPatchSchema.safeParse({}).success);
  for (const bad of [{ session: "" }, { session: "a b" }, { session: "../x" }, { session: "a".repeat(65) }, { session: 1 }, {}, "main", { session: "a", extra: 1 }, []]) assert.equal(ok(bad), false, JSON.stringify(bad));
});

test("coordinator: 保存と読み込み。null で消える。壊れた保存値は無効（別の session を統括にしない）", () => {
  const s = mergeSettings({}, { coordinator: { session: "main" } } as ProjectSettingsPatch);
  assert.equal(readCoordinator(s.coordinator), "main");
  assert.equal(readCoordinator(mergeSettings(s, { coordinator: null } as ProjectSettingsPatch).coordinator), null);
  assert.equal(readCoordinator(readCenterSettings({ coordinator: { session: "bad name" } }).coordinator), null);
  assert.ok(!("coordinator" in readCenterSettings({ coordinator: "x" })));
  assert.equal(readCoordinator(undefined), null);
});

// ---- 指示文の部品 ----

test("部品 coordinator: 統括の session だけに付く。未設定の時の指示文は今と同じ（部品が増えない）", () => {
  const plain = { session: "a", memory: false };
  assert.deepEqual(applicableParts(plain).map(partLabel), ["base-spec@1", "master-cap-role@5", "master-cap-availability@2"]);
  assert.deepEqual(applicableParts({ ...plain, coordinator: false }).map(partLabel), ["base-spec@1", "master-cap-role@5", "master-cap-availability@2"]);
  assert.equal(buildSystemInstructions({ ...plain, coordinator: false }), buildSystemInstructions(plain));
  const co = buildSystemInstructions({ ...plain, coordinator: true });
  assert.deepEqual(applicableParts({ ...plain, coordinator: true }).map(partLabel), ["base-spec@1", "master-cap-role@5", "master-cap-availability@2", "coordinator@2"]);
  assert.ok(co.startsWith(buildSystemInstructions(plain)));
  // 文面はその時点で出す道具（session_brief）だけ。まだ無い道具の名前は出ない
  assert.match(co, /session_brief/);
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

// ---- 道具の出し分けと断り（in-memory） ----

const connectMem = async (owner: string, coordinator: CoordinatorDeps | undefined): Promise<Client> => {
  const s = createSessionMcpServer({ remotes: {} as RemoteManager, owner, ...(coordinator ? { coordinator } : {}) });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await s.connect(st);
  const c = new Client({ name: "t", version: "0" });
  await c.connect(ct);
  return c;
};
const names = async (c: Client): Promise<string[]> => (await c.listTools()).tools.map((t) => t.name);

test("道具の出し分け: 統括の session だけに session_brief が出る。他の session・未設定・coordinator 引数なしでは出ない", async () => {
  let coord: string | null = "main";
  const deps: CoordinatorDeps = { session: () => coord, sessions: () => [info("main"), info("other")], now: () => NOW };
  const baseline = await names(await connectMem("other", undefined));
  assert.ok(!baseline.includes("session_brief"));
  assert.ok((await names(await connectMem("main", deps))).includes("session_brief"));
  assert.deepEqual(await names(await connectMem("other", deps)), baseline);
  // 統括以外の道具の一覧は、統括の session でも session_brief を足しただけ
  assert.deepEqual((await names(await connectMem("main", deps))).filter((n) => n !== "session_brief"), baseline);
  coord = null;
  assert.deepEqual(await names(await connectMem("main", deps)), baseline);
  assert.deepEqual(await names(await connectMem("main", undefined)), baseline);
});

test("session_brief: 統括の session が呼ぶと 1 行ずつ返る。session で絞れる。未定義の session は error", async () => {
  const deps: CoordinatorDeps = { session: () => "main", sessions: () => [info("main"), info("other")], now: () => NOW };
  const c = await connectMem("main", deps);
  const r = JSON.parse(text(await c.callTool({ name: "session_brief", arguments: {} }))) as { sessions: { name: string; line: string }[]; truncated: boolean };
  assert.deepEqual(r.sessions.map((s) => s.name), ["main", "other"]);
  assert.ok(!text(await c.callTool({ name: "session_brief", arguments: {} })).includes("SECRET"));
  const one = JSON.parse(text(await c.callTool({ name: "session_brief", arguments: { session: "other" } }))) as { sessions: unknown[] };
  assert.equal(one.sessions.length, 1);
  assert.ok(isError(await c.callTool({ name: "session_brief", arguments: { session: "nope" } })));
});

test("session_brief: 設定を外した後・別の session に替えた後に、古い MCP session から呼ぶと断られる", async () => {
  let coord: string | null = "main";
  const deps: CoordinatorDeps = { session: () => coord, sessions: () => [info("main")], now: () => NOW };
  const c = await connectMem("main", deps);
  assert.ok(!isError(await c.callTool({ name: "session_brief", arguments: {} })));
  coord = null;
  const r1 = await c.callTool({ name: "session_brief", arguments: {} });
  assert.ok(isError(r1));
  assert.match(text(r1), /統括の session だけ/);
  assert.ok(!text(r1).includes("main |"));
  coord = "other";
  assert.ok(isError(await c.callTool({ name: "session_brief", arguments: {} })));
  coord = "main";
  assert.ok(!isError(await c.callTool({ name: "session_brief", arguments: {} })));
});

// ---- coordinator_session_create ----

async function createRig(coord: { v: string | null }) {
  const dir = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "coord-create-"));
  const config = parseConfig({ workspace: join(dir, "ws"), projects: [] }, join(dir, "c.json"));
  const map = new Map<string, RcStatus>();
  const calls: string[] = [];
  const instr: Record<string, unknown> = {};
  const mk = (p: { name: string; path: string }): RcStatus => ({ project: p.name, path: p.path, state: "stopped", pid: null, sessionUrl: null, environmentUrl: null, restarts: 0, lastExit: null, startedAt: null, args: null, instructions: false, claude: { path: "claude", source: "PATH" }, auth: "ok", loginUrl: null, loginError: null }) as RcStatus;
  const sup = {
    add: (p: { name: string; path: string }, o?: unknown) => { calls.push(`add:${p.name}`); instr[p.name] = o; map.set(p.name, mk(p)); },
    remove: async (n: string) => void map.delete(n),
    start: async (n: string) => { calls.push(`start:${n}`); const s = map.get(n)!; s.state = "connected"; s.sessionUrl = "u"; return { ...s }; },
    status: (n: string) => ({ ...map.get(n)! }),
    list: () => [...map.values()].map((s) => ({ ...s })),
    setCoordinator: () => {}, setInstructions: () => {}, setAddDirs: () => {}, setOutputStyle: () => {}, setMemory: () => {},
  } as unknown as RemoteControlSupervisor;
  const mgr = createSessionManager({ config, supervisor: sup, store: createJsonListStore<SavedSession>(join(dir, "sessions.json"), () => {}), log: () => {}, waitMs: 0 });
  await mgr.restore();
  const deps: CoordinatorDeps = { session: () => coord.v, sessions: () => mgr.list(), createSession: createSessionVia(mgr) };
  const call = async (owner: string, args: Record<string, unknown>) => (await connectMem(owner, deps)).callTool({ name: "coordinator_session_create", arguments: args });
  return { dir, ws: join(dir, "ws"), calls, instr, mgr, deps, call, clean: () => rm(dir, { recursive: true, force: true }) };
}

test("coordinator_session_create: 統括の session だけに出る。統括でない session・未設定には出ない", async () => {
  const r = await createRig({ v: "main" });
  try {
    assert.ok((await names(await connectMem("main", r.deps))).includes("coordinator_session_create"));
    assert.ok(!(await names(await connectMem("other", r.deps))).includes("coordinator_session_create"));
    assert.ok(!(await names(await connectMem("main", { ...r.deps, session: () => null }))).includes("coordinator_session_create"));
  } finally { await r.clean(); }
});

test("coordinator_session_create: 設定を外した後・別の session に替えた後は、古い MCP session から呼んでも断られ、何も作られない", async () => {
  const coord = { v: "main" as string | null };
  const r = await createRig(coord);
  try {
    const c = await connectMem("main", r.deps);
    coord.v = null;
    assert.ok(isError(await c.callTool({ name: "coordinator_session_create", arguments: { name: "p1" } })));
    coord.v = "other";
    assert.ok(isError(await c.callTool({ name: "coordinator_session_create", arguments: { name: "p1" } })));
    assert.deepEqual(r.calls, []);
    assert.equal(r.mgr.list().length, 0);
  } finally { await r.clean(); }
});

test("coordinator_session_create: 作った session が一覧に出て、起動される。作業 dir は workspace の下。instructions は session の設定に入る", async () => {
  const r = await createRig({ v: "main" });
  try {
    const res = await r.call("main", { name: "proj-1", instructions: "最初の説明" });
    assert.ok(!isError(res), text(res));
    assert.deepEqual(r.calls, ["add:proj-1", "start:proj-1"]);
    const li = r.mgr.list().find((s) => s.name === "proj-1");
    assert.equal(li?.path, join(r.ws, "proj-1"));
    assert.equal(li?.source, "session");
    assert.equal((r.instr["proj-1"] as { instructions?: string }).instructions, "最初の説明");
    assert.ok((await stat(join(r.ws, "proj-1"))).isDirectory());
    assert.ok(!text(res).includes(r.dir));
  } finally { await r.clean(); }
});

test("coordinator_session_create: start = false なら作るだけで起動しない", async () => {
  const r = await createRig({ v: "main" });
  try {
    assert.ok(!isError(await r.call("main", { name: "idle-1", start: false })));
    assert.deepEqual(r.calls, ["add:idle-1"]);
    assert.equal(r.mgr.list()[0]?.state, "stopped");
  } finally { await r.clean(); }
});

test("coordinator_session_create: 同じ名前・形の崩れた名前・.. や / を含む名前は断られ、workspace の外に何も作られない", async () => {
  const r = await createRig({ v: "main" });
  try {
    assert.ok(!isError(await r.call("main", { name: "dup" })));
    assert.ok(isError(await r.call("main", { name: "dup" })));
    for (const bad of ["..", ".", "../x", "a/b", "/abs", "a b", "", "a\\b", "..%2f", "x/../../y"]) {
      assert.ok(isError(await r.call("main", { name: bad })), bad);
    }
    assert.deepEqual(r.calls, ["add:dup", "start:dup"]);
    assert.deepEqual(await readdir(r.ws), ["dup"]);
    assert.deepEqual((await readdir(r.dir)).sort(), ["sessions.json", "ws"]);
    // path は引数に無い: 渡しても作業 dir は決まった場所
    const res = await r.call("main", { name: "p2", path: "/etc/evil" });
    assert.equal(r.mgr.list().find((s) => s.name === "p2")?.path, join(r.ws, "p2"));
    assert.ok(!isError(res));
  } finally { await r.clean(); }
});

// ---- 実の HTTP: TTL と center の再起動 ----

async function bootHttp(coordinator: CoordinatorDeps, ttl?: number) {
  const tokens = createSessionTokens();
  const h = await startHttpServer({
    createServer: () => {
      throw new Error("外向けは使わない");
    },
    createSessionServer: (owner) => createSessionMcpServer({ remotes: {} as RemoteManager, owner, coordinator }),
    sessionAuth: tokens,
    core: createCore(),
    events: createEventHub(),
    port: 0,
    log: () => {},
    bind: "127.0.0.1",
    token: "outer-token-0123456789",
    ...(ttl !== undefined ? { sessionIdleTtlMs: ttl, sweepIntervalMs: 20 } : {}),
  });
  const connect = async (name: string): Promise<Client> => {
    const c = new Client({ name: "s", version: "0" });
    await c.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${h.port}/mcp/session`), { requestInit: { headers: { authorization: `Bearer ${tokens.issue(name)}`, "X-Bantou-Session": name } } }));
    return c;
  };
  return { h, connect };
}

test("http: MCP session が TTL で閉じられた後の作り直しで、道具の一覧は今の設定を映す。古い session からの呼び出しは断られる", async () => {
  let coord: string | null = "main";
  const { h, connect } = await bootHttp({ session: () => coord, sessions: () => [info("main")], now: () => NOW }, 80);
  try {
    const old = await connect("main");
    assert.ok((await names(old)).includes("session_brief"));
    const other = await connect("other");
    assert.ok(!(await names(other)).includes("session_brief"));
    coord = null;
    // 設定を外した後、まだ閉じていない古い MCP session から呼ぶと断られる
    assert.ok(isError(await old.callTool({ name: "session_brief", arguments: {} })));
    // TTL で閉じられた後、作り直した MCP session の一覧に出ない
    await new Promise((r) => setTimeout(r, 300));
    assert.ok(!(await names(await connect("main"))).includes("session_brief"));
    coord = "main";
    assert.ok((await names(await connect("main"))).includes("session_brief"));
  } finally {
    await h.close();
  }
});

test("http: center の再起動の後（新しい server・同じ設定）も、統括の session だけに道具が出る", async () => {
  const coord = "main";
  const mk = () => bootHttp({ session: () => coord, sessions: () => [info("main")], now: () => NOW });
  const a = await mk();
  try {
    assert.ok((await names(await a.connect("main"))).includes("session_brief"));
  } finally {
    await a.h.close();
  }
  const b = await mk();
  try {
    assert.ok((await names(await b.connect("main"))).includes("session_brief"));
    assert.ok(!(await names(await b.connect("other"))).includes("session_brief"));
  } finally {
    await b.h.close();
  }
  // 再起動の後に設定が消えていれば出ない
  const c = await bootHttp({ session: () => null, sessions: () => [info("main")], now: () => NOW });
  try {
    assert.ok(!(await names(await c.connect("main"))).includes("session_brief"));
  } finally {
    await c.h.close();
  }
});
