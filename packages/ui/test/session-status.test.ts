import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { capActivity, sessionProgress } from "../composables/sessionStatus";
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
const bg = (subagents: number, tasks: number) => ({ subagents, tasks });

describe("(B) the cap's own state: 3 states, independent of work in progress", () => {
  test("waiting for a reply / just waiting / the cap itself busy", () => {
    assert.equal(capActivity(sess({ activity: "needs-input" }), true), "needs-input");
    assert.equal(capActivity(sess({ activity: "idle" }), true), "idle");
    assert.equal(capActivity(sess({ activity: "working" }), true), "working");
  });
  test("idle stays idle whatever is going on (subagent, background run, remote task)", () => {
    for (const o of [{ background: bg(2, 0) }, { background: bg(0, 1) }, { remote: { running: 2, waitingReply: 0 } }]) {
      assert.equal(capActivity(sess(o), true), "idle");
    }
  });
  test("an unanswered worker ask is needs-input even when the cap is idle or stopped", () => {
    assert.equal(capActivity(sess({ remote: { running: 1, waitingReply: 2 } }), true), "needs-input");
    assert.equal(capActivity(sess({ state: "stopped", remote: { running: 0, waitingReply: 1 } }), true), "needs-input");
  });
  test("remote trouble beats working / idle; unknown / stopped / unreachable center show nothing", () => {
    const issue = { server: "h", remoteId: "c" };
    assert.equal(capActivity(sess({ activity: "working", remote: { running: 1, waitingReply: 0, unreachable: [issue] } }), true), "remote-unreachable");
    assert.equal(capActivity(sess({ remote: { running: 0, waitingReply: 0, lost: [issue] } }), true), "remote-lost");
    assert.equal(capActivity(sess({ remote: { running: 0, waitingReply: 0, stopped: [{ ...issue, kind: "failed" }] } }), true), "remote-stopped");
    assert.equal(capActivity(sess({ remote: { running: 0, waitingReply: 0, stopped: [{ ...issue, kind: "no_result" }] } }), true), "remote-stopped");
    // a stopped mark does not hide an unanswered ask / an unreachable server, and it goes when the center stops reporting it (handled)
    assert.equal(capActivity(sess({ remote: { running: 0, waitingReply: 1, stopped: [issue] } }), true), "needs-input");
    assert.equal(capActivity(sess({ remote: { running: 1, waitingReply: 0, unreachable: [issue], stopped: [issue] } }), true), "remote-unreachable");
    assert.equal(capActivity(sess({ remote: { running: 0, waitingReply: 0 } }), true), "idle");
    assert.equal(capActivity(sess({ activity: "unknown" }), true), null);
    assert.equal(capActivity(sess({ state: "stopped" }), true), null);
    assert.equal(capActivity(sess(), false), null);
    assert.equal(capActivity(undefined, true), null);
  });
});

describe("(A) work in progress", () => {
  test("nothing going on: null", () => {
    assert.equal(sessionProgress(sess(), true), null);
    assert.equal(sessionProgress(sess({ background: bg(0, 0), remote: { running: 0, waitingReply: 0 } }), true), null);
  });
  test("idle cap + subagent / background run / remote task: in progress", () => {
    assert.deepEqual(sessionProgress(sess({ background: bg(1, 0) }), true), { cap: false, subagents: 1, tasks: 0, remote: 0 });
    assert.deepEqual(sessionProgress(sess({ background: bg(0, 3) }), true), { cap: false, subagents: 0, tasks: 3, remote: 0 });
    assert.deepEqual(sessionProgress(sess({ remote: { running: 2, waitingReply: 0 } }), true), { cap: false, subagents: 0, tasks: 0, remote: 2 });
  });
  test("the cap's own turn is progress; progress goes on while the cap waits for a reply", () => {
    assert.equal(sessionProgress(sess({ activity: "working" }), true)?.cap, true);
    assert.notEqual(sessionProgress(sess({ activity: "needs-input", background: bg(1, 0) }), true), null);
  });
  test("a remote cap in trouble is not progress; a stopped session / unreachable center has none", () => {
    const issue = { server: "h", remoteId: "c" };
    assert.equal(sessionProgress(sess({ remote: { running: 1, waitingReply: 0, unreachable: [issue] } }), true), null);
    assert.equal(sessionProgress(sess({ state: "stopped", background: bg(1, 0) }), true), null);
    assert.equal(sessionProgress(sess({ background: bg(1, 0) }), false), null);
  });
});
