import assert from "node:assert/strict";
import { createServer as createNetServer } from "node:net";
import { afterEach, beforeEach, test } from "node:test";
import { createMemoryQueue, MEMORY_BODY_MAX, MEMORY_TRUNCATED_MARK, type MemorySink } from "../src/memory.js";
import { createCenterMemoryEvents, createCenterMemorySink, type CenterMemoryEvents } from "../src/memory-events.js";
import type { MemorySetting } from "../src/project-settings.js";
import { startFakeMemory, type FakeMemory } from "./helpers/fake-memory.js";

let mem: FakeMemory;
let logs: string[];
let ev: CenterMemoryEvents | undefined;
let setting: MemorySetting | undefined;
beforeEach(async () => {
  mem = await startFakeMemory();
  logs = [];
  setting = { url: mem.url, token: mem.token };
});
afterEach(async () => {
  ev?.close();
  ev = undefined;
  await mem.close();
});

const waitFor = async (f: () => boolean, ms = 4000): Promise<void> => {
  const t = Date.now();
  while (!f()) {
    if (Date.now() - t > ms) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 5));
  }
};
const mk = (over: Partial<Parameters<typeof createCenterMemoryEvents>[0]> = {}): CenterMemoryEvents => {
  ev = createCenterMemoryEvents({
    memoryOf: () => setting,
    log: (l) => void logs.push(l),
    queue: createMemoryQueue({ sink: createCenterMemorySink(), log: (l) => void logs.push(l), baseMs: 10, maxMs: 40 }),
    ...over,
  });
  return ev;
};
const prompt = (text: string, extra: Record<string, unknown> = {}) => ({ hook_event_name: "UserPromptSubmit", session_id: "sid", prompt: text, ...extra });
const stop = (text: string, extra: Record<string, unknown> = {}) => ({ hook_event_name: "Stop", session_id: "sid", stop_hook_active: false, last_assistant_message: text, ...extra });

test("hook: UserPromptSubmit の prompt → user_prompt、Stop の last_assistant_message → assistant_message。header は Bearer と X-Agent-Id（既定は session 名）", async () => {
  const m = mk();
  m.onHook("pm1", prompt("こんにちは", { prompt_id: "p-1", bantou_ts: 1_700_000_000_000 }));
  m.onHook("pm1", stop("やあ", { prompt_id: "p-1", bantou_ts: 1_700_000_001_000 }));
  await waitFor(() => mem.recorded().length === 2);
  const [a, b] = mem.recorded();
  assert.equal(a.kind, "user_prompt");
  assert.deepEqual(a.sender, { session: "pm1" });
  assert.deepEqual(a.recipient, { session: "pm1" });
  assert.equal(a.body, "こんにちは");
  assert.equal(a.at, "2023-11-14T22:13:20.000Z");
  assert.equal(a.agentId, "pm1");
  assert.equal(b.kind, "assistant_message");
  assert.equal(b.body, "やあ");
  assert.ok(mem.calls.every((c) => c.authorization === `Bearer ${mem.token}`));
});

test("hook: agentId があれば X-Agent-Id はそれ。token が無ければ Authorization なし（fake は 401 → 届かない）", async () => {
  setting = { url: mem.url, token: mem.token, agentId: "fixed-agent" };
  mk().onHook("pm1", prompt("x", { bantou_ts: 1 }));
  await waitFor(() => mem.recorded().length === 1);
  assert.equal(mem.recorded()[0].agentId, "fixed-agent");
});

test("hook: 対象外の event・本文なし・空白だけは何も積まない（StopFailure の last_assistant_message は error 文なので使わない）", async () => {
  const m = mk();
  m.onHook("pm1", { hook_event_name: "StopFailure", last_assistant_message: "API Error: Rate limit reached" });
  m.onHook("pm1", { hook_event_name: "PreToolUse", prompt: "x" });
  m.onHook("pm1", { hook_event_name: "UserPromptSubmit" });
  m.onHook("pm1", prompt("   \n"));
  m.onHook("pm1", prompt(""));
  m.onHook("pm1", "string");
  m.onHook("pm1", null);
  m.onHook("pm1", []);
  assert.equal(await m.drain(500), true);
  assert.equal(mem.calls.length, 0);
});

test("memory 無効（設定なし）の session では何もしない・投げない", async () => {
  setting = undefined;
  const m = mk();
  m.onHook("pm1", prompt("hi", { bantou_ts: 1 }));
  m.task("pm1", { capId: "c", taskId: "t", goal: "g" });
  assert.equal(await m.drain(300), true);
  assert.equal(mem.calls.length, 0);
});

test("eventId: 同じ hook 呼び出しの再送は同じ id（memory が duplicate で弾く）、同じ内容の別の発言は別の id", async () => {
  const m = mk();
  const p = prompt("ok", { prompt_id: "p-1", bantou_ts: 1000 });
  m.onHook("pm1", p);
  m.onHook("pm1", { ...p }); // 再送
  m.onHook("pm1", prompt("ok", { prompt_id: "p-2", bantou_ts: 2000 })); // 同じ本文の別の発言
  m.onHook("pm1", prompt("ok", { bantou_ts: 3000 })); // prompt_id 無し（ts で区別）
  m.onHook("pm1", prompt("ok", { bantou_ts: 3001 }));
  await waitFor(() => mem.calls.length === 5);
  const ids = mem.calls.map((c) => c.args.eventId);
  assert.equal(ids[0], ids[1]);
  assert.equal(new Set(ids).size, 4);
  assert.deepEqual(mem.calls.map((c) => c.status), ["recorded", "duplicate", "recorded", "recorded", "recorded"]);
  assert.ok(ids.every((i) => typeof i === "string" && i.length <= 128 && i.startsWith("c1:pm1:u:")));
});

test("body: NUL を除き、65536 で切って末尾に印。切っても memory の検証を通る（invalid にならない）", async () => {
  const m = mk();
  m.onHook("pm1", prompt("a\u0000b" + "x".repeat(MEMORY_BODY_MAX + 100), { bantou_ts: 5 }));
  await waitFor(() => mem.calls.length === 1);
  const c = mem.calls[0];
  assert.equal(c.status, "recorded");
  const body = c.args.body as string;
  assert.equal(body.length, MEMORY_BODY_MAX);
  assert.ok(body.endsWith(MEMORY_TRUNCATED_MARK));
  assert.ok(!body.includes("\u0000"));
});

test("at: hook の発火時刻。未来すぎる値は受けた時刻に直す（memory は +1 日までしか受けない）", async () => {
  const m = mk({ now: () => Date.parse("2026-11-11T00:00:00Z") });
  m.onHook("pm1", prompt("far", { bantou_ts: Date.parse("2030-01-01T00:00:00Z") }));
  await waitFor(() => mem.calls.length === 1);
  assert.equal(mem.calls[0].status, "recorded");
  assert.equal(mem.calls[0].args.at, "2026-11-11T00:00:00.000Z");
});

test("再試行: memory が落ちている間は積み、戻れば順序どおり送る。hook は待たずに即 return する。log は eventId と理由のみで token と本文を含まない", async () => {
  mem.setDown(true);
  const m = mk();
  const t0 = Date.now();
  for (let i = 1; i <= 3; i++) m.onHook("pm1", prompt(`secret-body-${i}`, { bantou_ts: i }));
  assert.ok(Date.now() - t0 < 100, "onHook は同期で戻る");
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(mem.recorded().length, 0);
  mem.setDown(false);
  await waitFor(() => mem.recorded().length === 3);
  assert.deepEqual(mem.recorded().map((e) => e.body), ["secret-body-1", "secret-body-2", "secret-body-3"]);
  assert.ok(logs.some((l) => l.includes("eventId=c1:pm1:u:")));
  const hay = logs.join("\n");
  assert.ok(!hay.includes(mem.token));
  assert.ok(!hay.includes("secret-body"));
  assert.ok(!hay.includes(mem.url));
});

test("到達不能な endpoint でも onHook は投げず、log に token が出ない", async () => {
  setting = { url: "http://127.0.0.1:9/mcp", token: "TOP-SECRET-TOKEN" };
  const m = mk();
  m.onHook("pm1", prompt("x", { bantou_ts: 1 }));
  await new Promise((r) => setTimeout(r, 150));
  assert.ok(logs.length > 0);
  assert.ok(!logs.join("\n").includes("TOP-SECRET-TOKEN"));
});

test("キュー上限: 1000 件を超えたら古い分から捨てて log（sink が詰まっていても hook は止まらない）", async () => {
  const sink: MemorySink = { send: () => new Promise(() => {}) };
  const m = createCenterMemoryEvents({ memoryOf: () => setting, log: (l) => void logs.push(l), sink });
  ev = m;
  for (let i = 0; i < 1005; i++) m.onHook("pm1", prompt(`p${i}`, { bantou_ts: i + 1 }));
  assert.equal(logs.filter((l) => l.includes("キューが 1000 件を超えた")).length, 5);
});

test("remote 往復: task / result / report / reply の種別・送り手・受け手・eventId（namespace c1）", async () => {
  const m = mk();
  m.task("pm1", { capId: "c-x-pm1", taskId: "t-1", goal: "do it", repo: "https://r", constraints: ["no push"] });
  m.result("pm1", { bantou: 1, type: "task_result", cap_id: "c-x-pm1", task_id: "t-1", state: "done", summary: "fine", workers: [], review: { verdict: "unknown", items: [], rounds: 0 }, remaining: ["x"] });
  m.report("pm1", { bantou: 1, type: "worker_report", cap_id: "c-x-pm1", task_id: "t-1", worker_id: "w-1", kind: "ask", text: "which?", at: "2026-11-11T01:00:00.000Z" });
  m.reply("pm1", { capId: "c-x-pm1", workerId: "w-1", text: "this one", taskId: "t-1" });
  await waitFor(() => mem.recorded().length === 4);
  const [t, r, p, y] = mem.recorded();
  assert.equal(t.kind, "task");
  assert.deepEqual([t.sender, t.recipient, t.remoteId, t.taskId], [{ session: "pm1" }, { capId: "c-x-pm1" }, "c-x-pm1", "t-1"]);
  assert.equal(t.eventId, "c1:pm1:task:t-1");
  assert.match(t.body as string, /^do it\nrepo: https:\/\/r\nconstraints:\n- no push$/);
  assert.equal(r.kind, "result");
  assert.deepEqual([r.sender, r.recipient], [{ capId: "c-x-pm1" }, { session: "pm1" }]);
  assert.match(r.body as string, /^\[done\] fine\nremaining:\n- x$/);
  assert.equal(p.kind, "report");
  assert.deepEqual([p.sender, p.recipient], [{ workerId: "w-1" }, { session: "pm1" }]);
  assert.equal(p.body, "(ask) which?");
  assert.equal(p.at, "2026-11-11T01:00:00.000Z");
  assert.equal(y.kind, "reply");
  assert.deepEqual([y.sender, y.recipient], [{ session: "pm1" }, { workerId: "w-1" }]);
  for (const e of mem.recorded()) assert.ok((e.eventId as string).startsWith("c1:pm1:"));
});

test("result の eventId: 同じ結果の二重受信（send と遅れた返信）は同じ id、同じ task_id の別の結果は別の id", async () => {
  const m = mk();
  const tr = (summary: string) => ({ bantou: 1 as const, type: "task_result" as const, cap_id: "c", task_id: "t-1", state: "done" as const, summary, workers: [], review: { verdict: "unknown" as const, items: [], rounds: 0 }, remaining: [] });
  m.result("pm1", tr("A"));
  m.result("pm1", tr("A"));
  m.result("pm1", tr("B"));
  await waitFor(() => mem.calls.length === 3);
  assert.deepEqual(mem.calls.map((c) => c.status), ["recorded", "duplicate", "recorded"]);
});

test("eventId: ts と prompt_id が同じでも本文が違う発言は別の eventId（user_prompt / assistant_message。digest を外すと同じ id になる）", async () => {
  const m = mk();
  m.onHook("pm1", prompt("one", { prompt_id: "p-1", bantou_ts: 1000 }));
  m.onHook("pm1", prompt("two", { prompt_id: "p-1", bantou_ts: 1000 }));
  m.onHook("pm1", stop("answer A", { prompt_id: "p-1", bantou_ts: 2000 }));
  m.onHook("pm1", stop("answer B", { prompt_id: "p-1", bantou_ts: 2000 }));
  await waitFor(() => mem.calls.length === 4);
  const ids = mem.calls.map((c) => c.args.eventId);
  assert.equal(new Set(ids).size, 4);
  assert.deepEqual(mem.calls.map((c) => c.status), ["recorded", "recorded", "recorded", "recorded"]);
  assert.deepEqual(mem.recorded().map((e) => e.body), ["one", "two", "answer A", "answer B"]);
});

test("hang する memory（接続は受けるが応答しない）でも onHook と remote の記録点は即戻る（実時間 100ms 以内）", async () => {
  const sockets = new Set<import("node:net").Socket>();
  const hang = createNetServer((s) => {
    sockets.add(s);
    s.on("error", () => {});
  });
  await new Promise<void>((r) => hang.listen(0, "127.0.0.1", r));
  const port = (hang.address() as import("node:net").AddressInfo).port;
  setting = { url: `http://127.0.0.1:${port}/mcp`, token: "HANG-TOKEN" };
  try {
    const m = mk({ queue: createMemoryQueue({ sink: createCenterMemorySink(), log: (l) => void logs.push(l) }) });
    const timed = (f: () => void): number => {
      const t = performance.now();
      f();
      return performance.now() - t;
    };
    // 1 件目で接続が張られて応答待ちのまま固まる。その後の呼び出しも待たされない
    assert.ok(timed(() => m.onHook("pm1", prompt("first", { bantou_ts: 1 }))) < 100);
    await new Promise((r) => setTimeout(r, 50));
    const rep = { bantou: 1 as const, type: "worker_report" as const, cap_id: "c", worker_id: "w", kind: "ask" as const, text: "q", at: "2026-11-11T00:00:00.000Z" };
    const tr = { bantou: 1 as const, type: "task_result" as const, cap_id: "c", task_id: "t", state: "done" as const, summary: "s", workers: [], review: { verdict: "unknown" as const, items: [], rounds: 0 }, remaining: [] };
    for (const f of [
      () => m.onHook("pm1", prompt("second", { bantou_ts: 2 })),
      () => m.onHook("pm1", stop("answer", { bantou_ts: 3 })),
      () => m.task("pm1", { capId: "c", taskId: "t", goal: "g" }),
      () => m.result("pm1", tr),
      () => m.report("pm1", rep),
      () => m.reply("pm1", { capId: "c", workerId: "w", text: "x" }),
    ]) assert.ok(timed(f) < 100);
    assert.equal(await m.drain(100), false); // 送れずに残っている（詰まっても呼び出し側は止まらない）
  } finally {
    ev?.close();
    ev = undefined;
    for (const s of sockets) s.destroy();
    await new Promise<void>((r) => hang.close(() => r()));
  }
});
