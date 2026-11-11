import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MEMORY_BODY_MAX, MEMORY_TRUNCATED_MARK, MEMORY_MIN_PROTOCOL, supportsMemory, readTaskMemory, sanitizeBody, makeEventId, eventAt,
  buildEvent, createMemoryQueue, PermanentMemoryError, redactReason, createMcpEventSink, digest8, MESSENGER_PROTOCOL,
} from "../dist/index.js";

const ev = (id) => ({ eventId: id, sender: { session: "s" }, kind: "task", body: "b", at: "2026-11-11T00:00:00.000Z" });
const tgt = { url: "http://m/mcp", token: "SECRET-TOKEN", agentId: "a" };

test("supportsMemory: 1.9.0 以上だけ true。MESSENGER_PROTOCOL は門を満たす", () => {
  assert.equal(MEMORY_MIN_PROTOCOL, "1.9.0");
  for (const v of ["1.9.0", "1.9.1", "1.10.0", "2.0.0"]) assert.equal(supportsMemory(v), true, v);
  for (const v of ["1.8.0", "1.8.9", undefined, "", "x", "1.9"]) assert.equal(supportsMemory(v), false, String(v));
  assert.equal(supportsMemory(MESSENGER_PROTOCOL.version), true);
});

test("readTaskMemory: 壊れた値は捨てる（例外にしない）。userinfo / 非 http は不可", () => {
  assert.deepEqual(readTaskMemory({ url: "http://m/mcp", token: "tk", agent_id: "cap-1", session: "s1" }), { url: "http://m/mcp", token: "tk", agent_id: "cap-1", session: "s1" });
  assert.deepEqual(readTaskMemory({ url: "https://m/mcp" }), { url: "https://m/mcp" });
  for (const v of [undefined, null, "x", [], {}, { url: "" }, { url: "ftp://m" }, { url: "http://u:p@m/" }, { url: "not a url" }, { url: 1 }]) assert.equal(readTaskMemory(v), undefined, JSON.stringify(v));
  assert.deepEqual(readTaskMemory({ url: "http://m/", token: "has space", agent_id: "bad id", session: 3 }), { url: "http://m/" });
});

test("sanitizeBody: NUL を除き、65536 で切って末尾に印。空は undefined。サロゲートを割らない", () => {
  assert.equal(sanitizeBody("a\u0000b"), "ab");
  assert.equal(sanitizeBody(" \n\u0000"), undefined);
  const long = "x".repeat(MEMORY_BODY_MAX + 10);
  const cut = sanitizeBody(long);
  assert.equal(cut.length, MEMORY_BODY_MAX);
  assert.ok(cut.endsWith(MEMORY_TRUNCATED_MARK));
  assert.equal(sanitizeBody("x".repeat(MEMORY_BODY_MAX)).length, MEMORY_BODY_MAX);
  const emoji = "x".repeat(MEMORY_BODY_MAX - MEMORY_TRUNCATED_MARK.length - 1) + "😀".repeat(20);
  const c2 = sanitizeBody(emoji);
  assert.ok(c2.length <= MEMORY_BODY_MAX);
  assert.ok(!/[\ud800-\udbff]$/.test(c2.slice(0, c2.length - MEMORY_TRUNCATED_MARK.length)));
});

test("makeEventId: 同じ部品は同じ id、違う部品は違う id、128 文字以内（長い名前は digest）", () => {
  assert.equal(makeEventId("c1", "s", "task", "t-1"), makeEventId("c1", "s", "task", "t-1"));
  assert.notEqual(makeEventId("c1", "s", "task", "t-1"), makeEventId("s1", "s", "task", "t-1"));
  assert.notEqual(makeEventId("c1", "s", "u", 1, digest8("a")), makeEventId("c1", "s", "u", 1, digest8("b")));
  const long = makeEventId("c1", "s".repeat(300), "task", "t-1");
  assert.ok(long.length <= 128);
  assert.notEqual(long, makeEventId("c1", "s".repeat(300), "task", "t-2"));
  assert.match(makeEventId("c1", "a b/c"), /^c1:a_b_c$/);
});

test("eventAt / buildEvent", () => {
  assert.equal(eventAt(Date.parse("2026-01-01T00:00:00Z"), Date.parse("2026-11-11T00:00:00Z")), "2026-01-01T00:00:00.000Z");
  assert.equal(eventAt(Date.parse("2030-01-01T00:00:00Z"), Date.parse("2026-11-11T00:00:00Z")), "2026-11-11T00:00:00.000Z");
  assert.equal(eventAt("garbage", 0 + 1000), "1970-01-01T00:00:01.000Z");
  assert.equal(buildEvent({ ...ev("x"), body: "\u0000" }), undefined);
  assert.equal(buildEvent({ ...ev("x"), body: "ok" }).body, "ok");
});

test("redactReason: token と Bearer を伏せる", () => {
  const r = redactReason(new Error("fail Bearer SECRET-TOKEN and SECRET-TOKEN"), "SECRET-TOKEN");
  assert.ok(!r.includes("SECRET-TOKEN"));
  assert.ok(redactReason("x".repeat(500)).length <= 201);
});

const waitFor = async (f, ms = 2000) => { const t = Date.now(); while (!f()) { if (Date.now() - t > ms) throw new Error("timeout"); await new Promise((r) => setTimeout(r, 2)); } };

test("queue: 順序保持、失敗は backoff で再試行、成功まで先頭を保つ。log に token・body が出ない", async () => {
  const sent = []; const logs = []; let fail = 3;
  const q = createMemoryQueue({ baseMs: 5, maxMs: 20, log: (l) => logs.push(l), sink: { send: async (t, e) => { if (fail > 0) { fail--; throw new Error(`down Bearer ${t.token}`); } sent.push(e.eventId); } } });
  q.enqueue("s", tgt, ev("e1")); q.enqueue("s", tgt, ev("e2")); q.enqueue("s", tgt, ev("e3"));
  assert.equal(await q.drain(3000), true);
  assert.deepEqual(sent, ["e1", "e2", "e3"]);
  assert.equal(logs.filter((l) => l.includes("再試行")).length, 3);
  assert.ok(logs.every((l) => l.includes("eventId=e1") && !l.includes("SECRET-TOKEN") && !l.includes("http://m")));
  q.close();
});

test("queue: backoff は倍々で maxMs が上限", async () => {
  const waits = [];
  const q = createMemoryQueue({ baseMs: 10, maxMs: 40, log: (l) => { const m = /（(\d+)ms 後/.exec(l); if (m) waits.push(Number(m[1])); }, sink: { send: async () => { throw new Error("x"); } } });
  q.enqueue("s", tgt, ev("e1"));
  await waitFor(() => waits.length >= 5, 4000);
  assert.deepEqual(waits.slice(0, 5), [10, 20, 40, 40, 40]);
  q.close();
});

test("queue: 上限超えは古い分から捨てて log。残りは順序どおり", async () => {
  const sent = []; const logs = []; let release;
  const gate = new Promise((r) => (release = r));
  const q = createMemoryQueue({ max: 3, log: (l) => logs.push(l), sink: { send: async (_t, e) => { await gate; sent.push(e.eventId); } } });
  for (let i = 1; i <= 6; i++) q.enqueue("s", tgt, ev(`e${i}`));
  release();
  await q.drain(2000);
  assert.ok(logs.some((l) => l.includes("キューが 3 件を超えた")));
  // 送信中の e1 は落とさず、待ちの古い分（e2, e3, e4）から落ちる
  assert.deepEqual(sent, ["e1", "e5", "e6"]);
  q.close();
});

test("queue: PermanentMemoryError は捨てて次へ進む。lane 同士は止め合わない", async () => {
  const sent = [];
  const q = createMemoryQueue({ baseMs: 5, log: () => {}, sink: { send: async (t, e) => { if (e.eventId === "bad") throw new PermanentMemoryError("invalid"); if (t.agentId === "stuck") throw new Error("down"); sent.push(e.eventId); } } });
  q.enqueue("s", { ...tgt, agentId: "stuck" }, ev("x1"));
  q.enqueue("s", tgt, ev("bad")); q.enqueue("s", tgt, ev("ok"));
  await waitFor(() => sent.includes("ok"));
  assert.deepEqual(sent, ["ok"]);
  q.close();
});

test("queue: enqueue は同期で戻り、sink が固まっても止まらない。close 後は何もしない", async () => {
  const q = createMemoryQueue({ log: () => {}, sink: { send: () => new Promise(() => {}) } });
  const t0 = Date.now(); q.enqueue("s", tgt, ev("e1")); assert.ok(Date.now() - t0 < 50);
  assert.equal(q.size(), 1);
  q.close(); q.enqueue("s", tgt, ev("e2")); assert.equal(q.size(), 0);
});

test("mcp sink: header と event tool を呼ぶ。isError は Permanent、throw は再試行用。失敗後は作り直す", async () => {
  const made = []; let mode = "ok";
  class Client { constructor() { this.calls = []; } async connect(t) { this.t = t; made.push(this); } async callTool(p) { this.calls.push(p); if (mode === "err") return { isError: true, content: [{ type: "text", text: "bad" }] }; if (mode === "throw") throw new Error("net"); return { content: [] }; } async close() { this.closed = true; } }
  class Transport { constructor(url, o) { this.url = url; this.headers = o.requestInit.headers; } }
  const sink = createMcpEventSink({ Client, StreamableHTTPClientTransport: Transport }, { clientName: "t" });
  await sink.send(tgt, ev("e1"));
  assert.equal(made[0].t.headers.Authorization, "Bearer SECRET-TOKEN");
  assert.equal(made[0].t.headers["X-Agent-Id"], "a");
  assert.equal(made[0].calls[0].name, "event");
  assert.equal(made[0].calls[0].arguments.eventId, "e1");
  await sink.send(tgt, ev("e2"));
  assert.equal(made.length, 1);
  mode = "err";
  await assert.rejects(sink.send(tgt, ev("e3")), PermanentMemoryError);
  mode = "throw";
  await assert.rejects(sink.send(tgt, ev("e4")), /net/);
  mode = "ok";
  await sink.send(tgt, ev("e5"));
  assert.equal(made.length, 2);
  const noTok = { url: "http://m/mcp", agentId: "b" };
  await sink.send(noTok, ev("e6"));
  assert.equal(made[2].t.headers.Authorization, undefined);
  await sink.close();
});

test("digest8 と makeEventId: 本文だけが違う 2 つは別 id、同じ本文は同じ id（digest 部品が id を分ける）", () => {
  assert.equal(digest8("same"), digest8("same"));
  assert.notEqual(digest8("one"), digest8("two"));
  assert.match(digest8("one"), /^[0-9a-f]{8}$/);
  const id = (text) => makeEventId("c1", "pm1", "u", "p-1", 1000, digest8(text));
  assert.notEqual(id("one"), id("two"));
  assert.equal(id("one"), id("one"));
  // digest を部品に入れない id は本文を区別できない（digest が必要な理由）
  assert.equal(makeEventId("c1", "pm1", "u", "p-1", 1000), makeEventId("c1", "pm1", "u", "p-1", 1000));
});
