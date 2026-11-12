// Inputs and expectations copied from the Rust tests of the desktop (design 5.6 #5).
// S = packages/desktop/src-tauri/src/session.rs (list / cache / serde reads). The center is a fake HTTP server on 127.0.0.1.
// Not ported (command arguments, work unit 3d): `rename_args` `normalize_settings` `create_args` `update_args` `settings_of` `workspace_of`.

import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import {
  SessionCache,
  SessionParseError,
  applyListing,
  createCenterMcp,
  createSessionService,
  emptySessionList,
  parseSession,
  parseSessions,
  type Session,
  type SessionList,
} from "../src/index.ts";
import { FakeCenter, deadUrl } from "./helpers/fake-center.ts";

const entry = (name: string, state: string): Session => ({
  name,
  state: state as Session["state"],
  sessionUrl: `https://claude.ai/code/${name}`,
  source: "session" as Session["source"],
  path: `/ws/${name}`,
  lastError: null,
  contextUsage: null,
  instructions: false,
  activity: null,
  activityAt: null,
  remote: null,
  auth: "ok" as Session["auth"],
  loginUrl: null,
  loginError: null,
});
const names = (l: SessionList) => l.sessions.map((s) => s.name);

test("S:463 answered list is shown as is", () => {
  const prev: SessionList = { sessions: [entry("old", "connected")], reachable: true, reason: null, rev: 0 };
  const next = applyListing(prev, { ok: [entry("a", "connected"), entry("b", "starting")] });
  assert.deepEqual(names(next), ["a", "b"]);
  assert.equal(next.reachable, true);
  assert.equal(next.reason, null);
});

test("S:471 center-side sessions appear and disappear with the list", () => {
  const first = applyListing(emptySessionList(), { ok: [entry("a", "connected")] });
  const second = applyListing(first, { ok: [entry("a", "connected"), entry("made-elsewhere", "connected")] });
  assert.equal(second.sessions.length, 2);
  const third = applyListing(second, { ok: [entry("made-elsewhere", "connected")] });
  assert.deepEqual(names(third), ["made-elsewhere"]);
  // an empty answer is an empty list (nothing is kept as lost)
  assert.deepEqual(applyListing(third, { ok: [] }).sessions, []);
});

test("S:483 unreachable keeps the last list and says why", () => {
  const ok = applyListing(emptySessionList(), { ok: [entry("a", "connected")] });
  const next = applyListing(ok, { err: "接続できない" });
  assert.deepEqual(next.sessions, ok.sessions);
  assert.equal(next.reachable, false);
  assert.equal(next.reason, "接続できない");
  // answered again: back to reachable, the list is the center's
  const back = applyListing(next, { ok: [] });
  assert.equal(back.reachable, true);
  assert.equal(back.reason, null);
  assert.deepEqual(back.sessions, []);
});

test("S:497 rev counts changes only", () => {
  const c = new SessionCache();
  assert.equal(c.get().rev, 0);
  assert.equal(c.apply({ ok: [entry("a", "connected")] }).list.rev, 1);
  // same answer: no change, same rev
  assert.equal(c.apply({ ok: [entry("a", "connected")] }).list.rev, 1);
  assert.equal(c.apply({ err: "x" }).list.rev, 2);
  assert.equal(c.apply({ err: "x" }).list.rev, 2);
  assert.equal(c.apply({ err: "y" }).list.rev, 3);
  assert.equal(c.apply({ ok: [entry("a", "connected")] }).list.rev, 4);
  assert.equal(c.get().rev, 4);
});

test("S:509 unreachable before any list is empty", () => {
  const next = applyListing(emptySessionList(), { err: "x" });
  assert.deepEqual(next.sessions, []);
  assert.equal(next.reachable, false);
});

test("S:516 cache reports whether a read changed anything", () => {
  const c = new SessionCache();
  assert.deepEqual(c.get(), emptySessionList());
  assert.equal(c.apply({ ok: [entry("a", "connected")] }).changed, true);
  assert.equal(c.apply({ ok: [entry("a", "connected")] }).changed, false);
  const r = c.apply({ err: "x" });
  assert.equal(r.changed, true);
  assert.equal(r.list.sessions.length, 1);
  assert.deepEqual(c.get(), r.list);
  // the same failure again is no change
  assert.equal(c.apply({ err: "x" }).changed, false);
});

test("the cache hands out copies: a caller cannot change what is cached", () => {
  const c = new SessionCache();
  c.apply({ ok: [entry("a", "connected")] });
  c.get().sessions[0]!.name = "changed";
  assert.equal(c.get().sessions[0]!.name, "a");
});

test("S:549 session reads the center json", () => {
  const e = parseSession(
    JSON.parse(
      '{"name":"pm-a","path":"/p","state":"connected","pid":1,"sessionUrl":"https://u","startedAt":null,"source":"session","lastError":"x","auth":"login_required","loginUrl":"https://claude.com/cai/oauth/authorize?x","loginError":"Invalid code"}',
    ),
  );
  assert.equal(e.sessionUrl, "https://u");
  assert.equal(e.lastError, "x");
  assert.equal(e.path, "/p");
  assert.equal(e.auth, "login_required");
  assert.equal(e.loginUrl, "https://claude.com/cai/oauth/authorize?x");
  assert.equal(e.loginError, "Invalid code");
  // keys the desktop does not know (pid, startedAt) are dropped
  assert.equal("pid" in e, false);
  const bare = parseSession({ name: "a" });
  assert.equal(bare.state, null);
  assert.equal(bare.auth, null);
  assert.equal(bare.loginUrl, null);
});

test("S:354 instructions flag is read and false when absent", () => {
  assert.equal(parseSession({ name: "a", instructions: true }).instructions, true);
  assert.equal(parseSession({ name: "a", instructions: false }).instructions, false);
  assert.equal(parseSession({ name: "a" }).instructions, false);
});

test("S:364 remote is read when the center sends it and null otherwise", () => {
  const s = parseSession({ name: "a", remote: { running: 2, waitingReply: 1 } });
  assert.deepEqual(s.remote, { running: 2, waitingReply: 1 });
  assert.equal(parseSession({ name: "a" }).remote, null);
  const bad = parseSession(
    JSON.parse(
      '{"name":"a","remote":{"running":0,"waitingReply":0,"unreachable":[{"server":"host-a","remoteId":"c-1-a","lastOkAt":"2026-11-10T20:57:00.000Z"}],"lost":[{"server":"host-b","remoteId":"c-1-b","at":"2026-11-10T21:26:00.000Z"}]}}',
    ),
  );
  const r = bad.remote!;
  assert.equal(r.unreachable![0]!.server, "host-a");
  assert.equal(r.unreachable![0]!.lastOkAt, "2026-11-10T20:57:00.000Z");
  assert.equal(r.lost![0]!.remoteId, "c-1-b");
  assert.deepEqual(parseSession({ name: "a", remote: { running: 1 } }).remote, { running: 1, waitingReply: 0 });
});

test("S:383 activity is read when the center sends it and null otherwise", () => {
  const s = parseSession({ name: "a", activity: "needs-input", activityAt: "2026-11-09T00:00:00.000Z" });
  assert.equal(s.activity, "needs-input");
  assert.equal(s.activityAt, "2026-11-09T00:00:00.000Z");
  const old = parseSession({ name: "a" });
  assert.deepEqual([old.activity, old.activityAt], [null, null]);
  const nul = parseSession({ name: "a", activity: "unknown", activityAt: null });
  assert.deepEqual([nul.activity, nul.activityAt], ["unknown", null]);
});

test("S:395 context usage is read when the center sends it and null otherwise", () => {
  const w = parseSession({
    name: "a",
    state: "connected",
    contextUsage: { usedTokens: 84000, windowTokens: 200000, percent: 42, updatedAt: "t" },
  });
  assert.deepEqual(w.contextUsage, { usedTokens: 84000, windowTokens: 200000, percent: 42, updatedAt: "t" });
  const unknown = parseSession({ name: "a", contextUsage: { usedTokens: 5, windowTokens: null, percent: null } });
  assert.equal(unknown.contextUsage!.windowTokens, null);
  assert.equal(parseSession({ name: "a" }).contextUsage, null);
  assert.equal(parseSession({ name: "a", contextUsage: null }).contextUsage, null);
});

test("a malformed list is an error, not a silent empty list", () => {
  assert.throws(() => parseSessions({}), SessionParseError);
  assert.throws(() => parseSessions([{ state: "connected" }]), SessionParseError);
  assert.throws(() => parseSession({ name: "a", instructions: "yes" }), SessionParseError);
  assert.throws(() => parseSession({ name: "a", contextUsage: { windowTokens: 1 } }), SessionParseError);
});

test("S:600 session list serializes for the frontend", () => {
  const v = JSON.parse(JSON.stringify(applyListing(emptySessionList(), { ok: [entry("a", "connected")] })));
  assert.equal(v.reachable, true);
  assert.equal(v.sessions[0].sessionUrl, "https://claude.ai/code/a");
  assert.equal(v.sessions[0].state, "connected");
  const e = JSON.parse(JSON.stringify(applyListing(emptySessionList(), { err: "x" })));
  assert.equal(e.reachable, false);
  assert.equal(e.reason, "x");
});

// -- service on a fake center -----------------------------------------------------

const centers: FakeCenter[] = [];
afterEach(async () => {
  await Promise.all(centers.splice(0).map((c) => c.close()));
});

test("refresh reads session_list, tells listeners only when the cache changed, keeps the old list when unreachable", async () => {
  const mock = await FakeCenter.start("tok-abcdefghij");
  centers.push(mock);
  mock.tools.set("session_list", [{ name: "a", state: "connected", pid: 1 }, { name: "b" }]);
  let url = mock.url;
  const mcp = createCenterMcp({
    settings: { selectTarget: async () => ({ url, token: "tok-abcdefghij", source: "remote" as const }) },
  });
  const svc = createSessionService({ mcp });
  let told = 0;
  const off = svc.onChanged(() => told++);
  assert.deepEqual(svc.get(), emptySessionList());

  const first = await svc.refresh();
  assert.deepEqual(names(first), ["a", "b"]);
  assert.deepEqual([first.reachable, first.rev, told], [true, 1, 1]);
  await svc.refresh();
  assert.deepEqual([svc.get().rev, told], [1, 1]);

  // the center cannot be asked: the older list, flagged
  url = await deadUrl();
  const lost = await svc.refresh();
  assert.deepEqual(names(lost), ["a", "b"]);
  assert.equal(lost.reachable, false);
  assert.ok(lost.reason!.includes("接続できない"), lost.reason!);
  assert.ok(!lost.reason!.includes("tok-abcdefghij"));
  assert.deepEqual([lost.rev, told], [2, 2]);

  // back: the center's list again
  url = mock.url;
  mock.tools.set("session_list", [{ name: "c" }]);
  const back = await svc.refresh();
  assert.deepEqual(names(back), ["c"]);
  assert.deepEqual([back.reachable, back.reason, back.rev], [true, null, 3]);
  off();
  mock.tools.set("session_list", []);
  await svc.refresh();
  assert.equal(told, 3);
});

test("an unreadable session_list answer keeps the list and says why", async () => {
  const mock = await FakeCenter.start();
  centers.push(mock);
  mock.tools.set("session_list", [{ name: "a" }]);
  const mcp = createCenterMcp({ settings: { selectTarget: async () => ({ url: mock.url, source: "remote" as const }) } });
  const svc = createSessionService({ mcp });
  await svc.refresh();
  mock.tools.set("session_list", { not: "a list" });
  const r = await svc.refresh();
  assert.deepEqual(names(r), ["a"]);
  assert.equal(r.reachable, false);
  assert.ok(r.reason!.startsWith("session_list の結果を読めない"), r.reason!);
  mock.rawTools.set("session_list", "garbage");
  const g = await svc.refresh();
  assert.ok(g.reason!.startsWith("session_list の結果を読めない"), g.reason!);
});

test("no target: the list is flagged unreachable with the reason", async () => {
  const mcp = createCenterMcp({ settings: { selectTarget: async () => undefined } });
  const svc = createSessionService({ mcp });
  const r = await svc.refresh();
  assert.equal(r.reachable, false);
  assert.ok(r.reason!.includes("接続先が無い"));
});

test("a listener that throws neither stops the other listeners nor fails refresh", async () => {
  const mock = await FakeCenter.start();
  centers.push(mock);
  mock.tools.set("session_list", [{ name: "a" }]);
  const mcp = createCenterMcp({ settings: { selectTarget: async () => ({ url: mock.url, source: "remote" as const }) } });
  const svc = createSessionService({ mcp });
  const calls: string[] = [];
  svc.onChanged(() => {
    calls.push("bad");
    throw new Error("listener bug");
  });
  svc.onChanged(() => calls.push("good"));
  const l = await svc.refresh();
  assert.deepEqual(names(l), ["a"]);
  assert.deepEqual(calls, ["bad", "good"]);
  // the cache was stored before the listeners ran
  assert.equal(svc.get().rev, 1);
});
