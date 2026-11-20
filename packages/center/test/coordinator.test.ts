import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildSessionBrief, SESSION_BRIEF_LINE_MAX, SESSION_BRIEF_MAX_CHARS, SESSION_BRIEF_MAX_LINES, type CoordinatorDeps } from "../src/coordinator.js";
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
  assert.deepEqual(applicableParts(plain).map(partLabel), ["master-cap-role@4", "master-cap-availability@1"]);
  assert.deepEqual(applicableParts({ ...plain, coordinator: false }).map(partLabel), ["master-cap-role@4", "master-cap-availability@1"]);
  assert.equal(buildSystemInstructions({ ...plain, coordinator: false }), buildSystemInstructions(plain));
  const co = buildSystemInstructions({ ...plain, coordinator: true });
  assert.deepEqual(applicableParts({ ...plain, coordinator: true }).map(partLabel), ["master-cap-role@4", "master-cap-availability@1", "coordinator@1"]);
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
