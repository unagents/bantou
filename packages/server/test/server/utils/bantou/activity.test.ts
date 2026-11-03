import { test } from "node:test";
import assert from "node:assert/strict";
import type { ActivityNotice } from "@agent-hand/bantou-protocol";
import {
  ACTIVITY_MAX,
  ERROR_MAX,
  TASK_MAX,
  createActivityTracker,
  summarizeLine,
} from "../../../../server/utils/bantou/activity";

const asst = (content: unknown[]) => JSON.stringify({ type: "assistant", message: { content } });

test("summarizeLine: assistant の tool_use は <name>: <hint>（description → command → file_path → pattern → prompt）", () => {
  assert.deepEqual(summarizeLine(asst([{ type: "tool_use", name: "Bash", input: { command: "ls", description: "list files" } }])), { activity: "Bash: list files" });
  assert.deepEqual(summarizeLine(asst([{ type: "tool_use", name: "Bash", input: { command: "ls\n -la" } }])), { activity: "Bash: ls -la" });
  assert.deepEqual(summarizeLine(asst([{ type: "tool_use", name: "Write", input: { file_path: "/a/b.ts", content: "x" } }])), { activity: "Write: /a/b.ts" });
  assert.deepEqual(summarizeLine(asst([{ type: "tool_use", name: "Grep", input: { pattern: "foo" } }])), { activity: "Grep: foo" });
  assert.deepEqual(summarizeLine(asst([{ type: "tool_use", name: "Agent", input: { prompt: "go" } }])), { activity: "Agent: go" });
  assert.deepEqual(summarizeLine(asst([{ type: "tool_use", name: "Foo", input: {} }])), { activity: "Foo" });
});

test("summarizeLine: text / thinking / tool_progress / task_started / init / result", () => {
  assert.deepEqual(summarizeLine(asst([{ type: "text", text: "調べる\nね" }])), { activity: "text: 調べる ね" });
  assert.deepEqual(summarizeLine(asst([{ type: "thinking", thinking: "..." }])), { activity: "thinking" });
  // 最後の block を採る
  assert.deepEqual(summarizeLine(asst([{ type: "text", text: "a" }, { type: "tool_use", name: "Read", input: { file_path: "f" } }])), { activity: "Read: f" });
  assert.deepEqual(summarizeLine(JSON.stringify({ type: "tool_progress", tool_name: "Bash", elapsed_time_seconds: 60.4, heartbeat: true })), { activity: "Bash 実行中 60s" });
  assert.deepEqual(summarizeLine(JSON.stringify({ type: "system", subtype: "task_started", description: "run tail" })), { activity: "task: run tail" });
  assert.deepEqual(summarizeLine(JSON.stringify({ type: "system", subtype: "init" })), { activity: "start" });
  assert.deepEqual(summarizeLine(JSON.stringify({ type: "result", subtype: "success" })), { activity: "result: success" });
});

test("summarizeLine: その他は activity null、JSON でなければ null。長さは ACTIVITY_MAX で切る", () => {
  for (const o of [{ type: "user" }, { type: "system", subtype: "hook_started" }, { type: "system", subtype: "thinking_tokens" }, { type: "rate_limit_event" }]) {
    assert.deepEqual(summarizeLine(JSON.stringify(o)), { activity: null });
  }
  assert.equal(summarizeLine("not json"), null);
  assert.equal(summarizeLine("[1]"), null);
  assert.deepEqual(summarizeLine(asst([])), { activity: null });
  const long = summarizeLine(asst([{ type: "text", text: "あ".repeat(500) }]));
  assert.equal(long?.activity?.length, ACTIVITY_MAX);
});

interface Fx {
  t: { now: number };
  sent: ActivityNotice[];
  tr: ReturnType<typeof createActivityTracker>;
  logs: string[];
}

function fx(opts: { intervalMs?: number; stalledMs?: number; fail?: boolean } = {}): Fx {
  const t = { now: Date.parse("2026-10-29T00:00:00.000Z") };
  const sent: ActivityNotice[] = [];
  const logs: string[] = [];
  const tr = createActivityTracker({
    notify: async (_c, n) => {
      if (opts.fail) throw new Error("send ng");
      sent.push(n);
    },
    log: (m) => logs.push(m),
    now: () => t.now,
    intervalMs: opts.intervalMs ?? 3_600_000,
    stalledMs: opts.stalledMs ?? 300_000,
  });
  return { t, sent, tr, logs };
}

const settle = (): Promise<void> => new Promise((r) => setImmediate(r));
const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

test("tracker: started で running、task は 1 行・TASK_MAX。silent_ms は最後の出力（無ければ started_at）から", async () => {
  const { t, tr, sent } = fx();
  try {
    tr.started("cap", "c1", { prompt: `a\n${"x".repeat(500)}` }, 10);
    t.now += 2_000;
    let [a] = tr.snapshot("c1");
    assert.equal(a!.state, "running");
    assert.equal(a!.cap_id, "c1");
    assert.equal(a!.task.length, TASK_MAX);
    assert.ok(!a!.task.includes("\n"));
    assert.equal(a!.silent_ms, 2_000);
    assert.equal(a!.last_output_at, null);
    assert.equal(a!.finished_at, null);
    tr.line("cap", "c1", asst([{ type: "text", text: "hello" }]));
    t.now += 500;
    [a] = tr.snapshot("c1");
    assert.equal(a!.last_activity, "text: hello");
    assert.equal(a!.silent_ms, 500);
    assert.equal(a!.last_output_at, new Date(t.now - 500).toISOString());
    // 状態遷移（started）は即送られる
    await settle();
    assert.equal(sent.length, 1);
    assert.equal(sent[0]!.type, "activity");
    assert.equal(sent[0]!.cap_id, "c1");
  } finally {
    tr.close();
  }
});

test("tracker: activity の無い行も出力として数え、last_activity は保つ", () => {
  const { t, tr } = fx();
  try {
    tr.started("cap", "c1", { prompt: "p" }, 1);
    tr.line("cap", "c1", asst([{ type: "text", text: "a" }]));
    t.now += 1000;
    tr.line("cap", "c1", JSON.stringify({ type: "user" }));
    tr.line("cap", "c1", "garbage");
    const [a] = tr.snapshot();
    assert.equal(a!.last_activity, "text: a");
    assert.equal(a!.silent_ms, 0);
  } finally {
    tr.close();
  }
});

test("tracker: cap は ok で idle、worker は ok で idle（done 報告が無い時）／done（kind=done を受けた時）", () => {
  const { tr } = fx();
  try {
    tr.started("cap", "c1", { prompt: "p" }, 1);
    tr.finished("cap", "c1", { ok: true, lost: false });
    tr.reported("c1", "done"); // cap 宛ては無視
    assert.equal(tr.snapshot("c1")[0]!.state, "idle");

    tr.started("worker", "w1", { prompt: "p", capId: "c1" }, 2);
    tr.reported("w1", "progress");
    tr.finished("worker", "w1", { ok: true, lost: false });
    tr.started("worker", "w2", { prompt: "p", capId: "c1" }, 3);
    tr.reported("w2", "done");
    tr.finished("worker", "w2", { ok: true, lost: false });
    const byId = Object.fromEntries(tr.snapshot("c1").map((a) => [a.id, a.state]));
    assert.deepEqual(byId, { c1: "idle", w1: "idle", w2: "done" });

    // 次の実行では done 報告が持ち越されない
    tr.started("worker", "w2", { prompt: "again", capId: "c1" }, 4);
    assert.equal(tr.snapshot("c1").find((a) => a.id === "w2")!.state, "running");
    tr.finished("worker", "w2", { ok: true, lost: false });
    assert.equal(tr.snapshot("c1").find((a) => a.id === "w2")!.state, "idle");
  } finally {
    tr.close();
  }
});

test("tracker: ok でない終了は failed、lost は lost。error は ERROR_MAX、finished_at が入る", () => {
  const { t, tr } = fx();
  try {
    tr.started("worker", "w1", { prompt: "p", capId: "c1" }, 1);
    t.now += 1000;
    tr.finished("worker", "w1", { ok: false, lost: false, error: "x".repeat(500) });
    let a = tr.snapshot("c1")[0]!;
    assert.equal(a.state, "failed");
    assert.equal(a.error!.length, ERROR_MAX);
    assert.equal(a.finished_at, new Date(t.now).toISOString());

    tr.started("worker", "w1", { prompt: "p", capId: "c1" }, 2);
    a = tr.snapshot("c1")[0]!;
    assert.equal(a.state, "running");
    assert.equal(a.error, undefined);
    assert.equal(a.finished_at, null);
    tr.finished("worker", "w1", { ok: false, lost: true, error: "signal SIGKILL で終了（server からの停止ではない）" });
    a = tr.snapshot("c1")[0]!;
    assert.equal(a.state, "lost");
    assert.match(a.error!, /SIGKILL/);
    // 未知の agent の finished は無視
    tr.finished("worker", "zzz", { ok: true, lost: false });
    assert.equal(tr.snapshot().length, 1);
  } finally {
    tr.close();
  }
});

test("tracker: keepTask の再開は task を上書きしない（新規なら入れる）", () => {
  const { tr } = fx();
  try {
    tr.started("cap", "c1", { prompt: "最初の依頼" }, 1);
    tr.finished("cap", "c1", { ok: true, lost: false });
    tr.started("cap", "c1", { prompt: "worker w1 から done: ok", keepTask: true }, 2);
    assert.equal(tr.snapshot("c1")[0]!.task, "最初の依頼");
    tr.started("cap", "c2", { prompt: "新規", keepTask: true }, 3);
    assert.equal(tr.snapshot("c2")[0]!.task, "新規");
    tr.started("cap", "c1", { prompt: "次の kick" }, 4);
    assert.equal(tr.snapshot("c1")[0]!.task, "次の kick");
  } finally {
    tr.close();
  }
});

test("tracker: 無音が stalledMs に達すると tick で stalled、新しい行で running に戻る", async () => {
  const { t, tr, sent } = fx({ intervalMs: 10, stalledMs: 300_000 });
  try {
    tr.started("worker", "w1", { prompt: "p", capId: "c1" }, 1);
    await settle();
    sent.length = 0;
    t.now += 299_000;
    await wait(30);
    assert.equal(tr.snapshot("c1")[0]!.state, "running");
    t.now += 1_000;
    await wait(30);
    assert.equal(tr.snapshot("c1")[0]!.state, "stalled");
    assert.equal(tr.snapshot("c1")[0]!.silent_ms, 300_000);
    assert.ok(sent.some((n) => n.agents[0]!.state === "stalled"));
    tr.line("worker", "w1", asst([{ type: "text", text: "back" }]));
    assert.equal(tr.snapshot("c1")[0]!.state, "running");
    // finished は stalled からも遷移できる
    t.now += 400_000;
    await wait(30);
    assert.equal(tr.snapshot("c1")[0]!.state, "stalled");
    tr.finished("worker", "w1", { ok: false, lost: true, error: "e" });
    assert.equal(tr.snapshot("c1")[0]!.state, "lost");
  } finally {
    tr.close();
  }
});

test("tracker: running がいる間は毎 tick 送り、全員が終端になったらその 1 通を送って止める", async () => {
  const { tr, sent } = fx({ intervalMs: 20 });
  try {
    tr.started("cap", "c1", { prompt: "p" }, 1);
    tr.started("worker", "w1", { prompt: "p", capId: "c1" }, 2);
    await settle();
    sent.length = 0;
    await wait(110);
    assert.ok(sent.length >= 3, `tick で送られた: ${sent.length}`);
    // cap が先、続いて worker
    assert.deepEqual(sent.at(-1)!.agents.map((a) => a.id), ["c1", "w1"]);

    tr.finished("cap", "c1", { ok: true, lost: false });
    await wait(40); // cap は終端だが worker が running なので送り続ける
    const n1 = sent.length;
    tr.finished("worker", "w1", { ok: false, lost: false, error: "x" });
    await settle();
    assert.ok(sent.length > n1);
    const last = sent.at(-1)!;
    assert.deepEqual(last.agents.map((a) => a.state), ["idle", "failed"]);
    const n2 = sent.length;
    await wait(100);
    assert.equal(sent.length, n2, "全員が終端なら止まる");
  } finally {
    tr.close();
  }
});

test("tracker: 同じ同期区間の遷移は 1 通にまとめる。cap ごとに別通", async () => {
  const { tr, sent } = fx();
  try {
    tr.started("cap", "c1", { prompt: "p" }, 1);
    tr.started("worker", "w1", { prompt: "p", capId: "c1" }, 2);
    tr.started("worker", "w9", { prompt: "p", capId: "c9" }, 3);
    await settle();
    assert.equal(sent.length, 2);
    const c1 = sent.find((n) => n.cap_id === "c1")!;
    assert.deepEqual(c1.agents.map((a) => a.id), ["c1", "w1"]);
    assert.deepEqual(sent.find((n) => n.cap_id === "c9")!.agents.map((a) => a.id), ["w9"]);
  } finally {
    tr.close();
  }
});

test("tracker: seedLost は lost で登録して通知する", async () => {
  const { tr, sent } = fx();
  try {
    tr.seedLost("worker", "w1", "c1", "前回の実行が終了しないまま server が落ちた");
    await settle();
    const a = sent[0]!.agents[0]!;
    assert.equal(a.state, "lost");
    assert.equal(a.cap_id, "c1");
    assert.equal(a.error, "前回の実行が終了しないまま server が落ちた");
    assert.ok(a.finished_at);
    // 再実行すると running に戻る
    tr.started("worker", "w1", { prompt: "p", capId: "c1" }, 1);
    assert.equal(tr.snapshot("c1")[0]!.state, "running");
    assert.equal(tr.snapshot("c1")[0]!.error, undefined);
  } finally {
    tr.close();
  }
});

test("tracker: 送信失敗はログだけ。close 後は送らない", async () => {
  const f = fx({ fail: true });
  f.tr.started("cap", "c1", { prompt: "p" }, 1);
  await settle();
  assert.ok(f.logs.some((l) => l.includes("activity 送信失敗") && l.includes("send ng")));
  const g = fx();
  g.tr.close();
  g.tr.started("cap", "c1", { prompt: "p" }, 1);
  await settle();
  assert.equal(g.sent.length, 0);
});

test("tracker: snapshot は cap_id で絞り、cap → worker の id 昇順", () => {
  const { tr } = fx();
  try {
    tr.started("worker", "w2", { prompt: "p", capId: "c1" }, 1);
    tr.started("worker", "w1", { prompt: "p", capId: "c1" }, 2);
    tr.started("cap", "c1", { prompt: "p" }, 3);
    tr.started("cap", "c2", { prompt: "p" }, 4);
    assert.deepEqual(tr.snapshot("c1").map((a) => `${a.kind}:${a.id}`), ["cap:c1", "worker:w1", "worker:w2"]);
    assert.equal(tr.snapshot().length, 4);
    assert.deepEqual(tr.snapshot("none"), []);
  } finally {
    tr.close();
  }
});
