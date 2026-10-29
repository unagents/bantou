import assert from "node:assert/strict";
import { test } from "node:test";
import type { ActivityNotice, AgentActivity } from "@agent-hand/bantou-protocol";
import { ACTIVITY_STALE_MS, createActivityStore } from "../src/activity.js";

const agent = (id: string, state: AgentActivity["state"], silent_ms: number): AgentActivity => ({
  kind: id.startsWith("w") ? "worker" : "cap",
  id,
  cap_id: "r-1",
  state,
  task: "t",
  last_activity: null,
  last_output_at: null,
  silent_ms,
  started_at: null,
  finished_at: null,
});

const notice = (agents: AgentActivity[], capId = "r-1"): ActivityNotice => ({
  bantou: 1,
  type: "activity",
  cap_id: capId,
  at: "2026-10-29T01:00:05.000Z",
  agents,
});

test("get: 通知が無ければ undefined。通知の at と agents をそのまま返す", () => {
  const s = createActivityStore({ now: () => 0 });
  assert.equal(s.get("r-1"), undefined);
  s.apply(notice([agent("r-1", "idle", 0)]));
  const a = s.get("r-1")!;
  assert.equal(a.at, "2026-10-29T01:00:05.000Z");
  assert.equal(a.received_ms_ago, 0);
  assert.equal(a.stale, false);
  assert.equal(a.agents.length, 1);
  assert.equal(s.get("other"), undefined);
});

test("get: silent_ms は「通知時の値 + 受信からの経過」。保持している通知自体は変えない", () => {
  let now = 1000;
  const s = createActivityStore({ now: () => now });
  s.apply(notice([agent("r-1", "idle", 115_000), agent("w1", "running", 2_000)]));
  now += 1200;
  assert.deepEqual(s.get("r-1")!.agents.map((a) => a.silent_ms), [116_200, 3_200]);
  assert.equal(s.get("r-1")!.received_ms_ago, 1200);
  now += 800;
  assert.deepEqual(s.get("r-1")!.agents.map((a) => a.silent_ms), [117_000, 4_000]);
});

test("get: running / stalled がいるのに ACTIVITY_STALE_MS を超えて通知が無ければ stale。全員終端なら stale にならない", () => {
  let now = 0;
  const s = createActivityStore({ now: () => now });
  s.apply(notice([agent("r-1", "idle", 0), agent("w1", "running", 0)]));
  now = ACTIVITY_STALE_MS;
  assert.equal(s.get("r-1")!.stale, false);
  now = ACTIVITY_STALE_MS + 1;
  assert.equal(s.get("r-1")!.stale, true);
  // stalled でも同じ
  s.apply(notice([agent("w1", "stalled", 0)]));
  now += ACTIVITY_STALE_MS + 1;
  assert.equal(s.get("r-1")!.stale, true);
  // 新しい通知で戻る
  s.apply(notice([agent("w1", "running", 0)]));
  assert.equal(s.get("r-1")!.stale, false);
  // 全員が終端なら通知が来なくて当たり前
  s.apply(notice([agent("r-1", "idle", 0), agent("w1", "lost", 0)]));
  now += 10 * ACTIVITY_STALE_MS;
  assert.equal(s.get("r-1")!.stale, false);
});

test("apply は cap ごとの最新の通知で置き換える。forget で消える", () => {
  const s = createActivityStore({ now: () => 0 });
  s.apply(notice([agent("r-1", "running", 0), agent("w1", "running", 0)]));
  s.apply(notice([agent("r-1", "idle", 0)]));
  s.apply(notice([agent("r-2", "running", 0)], "r-2"));
  assert.equal(s.get("r-1")!.agents.length, 1);
  assert.equal(s.get("r-2")!.agents[0]!.id, "r-2");
  s.forget("r-1");
  assert.equal(s.get("r-1"), undefined);
  assert.ok(s.get("r-2"));
  s.forget("nope");
});
