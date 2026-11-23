import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { clickSleep, sleepButtonState } from "../composables/sleepButton";
import { sessionProgress } from "../composables/sessionStatus";
import type { Session } from "../types";

const sess = (o: Partial<Session> = {}): Session => ({
  name: "s",
  state: "connected",
  sessionUrl: null,
  source: "session",
  lastError: null,
  path: null,
  contextUsage: null,
  instructions: false,
  activity: "idle",
  activityAt: null,
  background: null,
  remote: null,
  auth: null,
  loginUrl: null,
  loginError: null,
  sleeping: false,
  ...o,
});
// the row as the board builds it: progress comes from `sessionProgress` (the same judgment as the "作業進行中" mark)
const row = (o: Partial<Session> = {}) => {
  const s = sess(o);
  return { name: s.name, sleeping: s.sleeping, progress: sessionProgress(s, true) };
};

describe("sleep button: pressable only when the session is not at work", () => {
  test("at work (cap busy / subagent / background run / remote task): disabled, with a reason", () => {
    for (const o of [{ activity: "working" as const }, { background: { subagents: 1, tasks: 0 } }, { background: { subagents: 0, tasks: 1 } }, { remote: { running: 1, waitingReply: 0 } }]) {
      const st = sleepButtonState(row(o));
      assert.equal(st.disabled, true);
      assert.match(st.title, /作業中/);
    }
  });
  test("not at work (idle): enabled", () => {
    assert.equal(sleepButtonState(row({ activity: "idle" })).disabled, false);
  });
  test("it becomes pressable again when the work ends", () => {
    assert.equal(sleepButtonState(row({ activity: "working" })).disabled, true);
    assert.equal(sleepButtonState(row({ activity: "idle" })).disabled, false);
  });
  test("a sleeping session stays disabled", () => {
    assert.equal(sleepButtonState(row({ sleeping: true })).disabled, true);
  });
  test("clicking while at work does not call the handler; clicking when idle does", () => {
    const calls: string[] = [];
    clickSleep(row({ name: "a", activity: "working" }), (n) => calls.push(n));
    assert.equal(calls.length, 0);
    clickSleep(row({ name: "b", activity: "idle" }), (n) => calls.push(n));
    assert.equal(calls.join(), "b");
  });
});
