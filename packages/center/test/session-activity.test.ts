import assert from "node:assert/strict";
import { test } from "node:test";
import { createEventHub, type SessionMessage } from "../src/events.js";
import { activityFromHook, createSessionActivityTracker, HOOK_EVENTS, lastMessageFromHook, publishLastMessage } from "../src/session-activity.js";
import { addHookTimestamp, hookCommand, hookUrl, runHook, statusLineSettingsJson } from "../src/status-line.js";

const ev = (hook_event_name: string, rest: Record<string, unknown> = {}) => ({ hook_event_name, ...rest });

test("activityFromHook: event ごとの状態", () => {
  assert.equal(activityFromHook(ev("UserPromptSubmit")), "working");
  assert.equal(activityFromHook(ev("PreToolUse", { tool_name: "Bash" })), "working");
  assert.equal(activityFromHook(ev("PostToolUse", { tool_name: "Bash" })), "working");
  assert.equal(activityFromHook(ev("PostToolUseFailure")), "working");
  assert.equal(activityFromHook(ev("PermissionDenied")), "working");
  assert.equal(activityFromHook(ev("PreToolUse", { tool_name: "AskUserQuestion" })), "needs-input");
  assert.equal(activityFromHook(ev("PreToolUse", { tool_name: "ExitPlanMode" })), "needs-input");
  assert.equal(activityFromHook(ev("PermissionRequest", { tool_name: "Bash" })), "needs-input");
  assert.equal(activityFromHook(ev("Notification", { notification_type: "permission_prompt" })), "needs-input");
  assert.equal(activityFromHook(ev("Notification", { notification_type: "elicitation_dialog" })), "needs-input");
  assert.equal(activityFromHook(ev("Notification", { notification_type: "idle_prompt" })), "idle");
  assert.equal(activityFromHook(ev("Notification", { notification_type: "auth_success" })), null);
  assert.equal(activityFromHook(ev("Stop")), "idle");
  assert.equal(activityFromHook(ev("StopFailure")), "idle");
  assert.equal(activityFromHook(ev("SessionStart", { source: "startup" })), "idle");
  assert.equal(activityFromHook(ev("SessionStart", { source: "compact" })), null);
});

test("activityFromHook: 未対応の event・壊れた入力は null", () => {
  for (const v of [ev("SessionEnd"), ev("Foo"), {}, null, "x", [], 1]) assert.equal(activityFromHook(v), null);
});

test("tracker: 状態が変わった時だけ true。running でない・起動し直し・hook 無しは unknown", () => {
  const t = createSessionActivityTracker({ now: () => Date.parse("2026-11-09T00:00:00Z") });
  assert.deepEqual(t.get("a", "S1", true), { activity: "unknown", activityAt: null });
  assert.equal(t.apply("a", ev("UserPromptSubmit"), "S1"), true);
  assert.equal(t.apply("a", ev("PostToolUse"), "S1"), false, "同じ状態");
  assert.deepEqual(t.get("a", "S1", true), { activity: "working", activityAt: "2026-11-09T00:00:00.000Z" });
  assert.equal(t.apply("a", ev("Stop"), "S1"), true);
  assert.equal(t.get("a", "S1", true).activity, "idle");
  assert.equal(t.get("a", "S1", false).activity, "unknown", "停止中は unknown");
  assert.equal(t.get("a", "S2", true).activity, "unknown", "起動し直したら捨てる");
  assert.equal(t.get("b", "S1", true).activity, "unknown", "別 session");
  assert.equal(t.apply("a", ev("Stop"), null), false, "startedAt 無しは反映しない");
  assert.equal(t.apply("a", ev("Foo"), "S1"), false);
});

test("tracker: 発火時刻が古い event は捨てる（到着順の入れ替わり）", () => {
  const t = createSessionActivityTracker();
  t.apply("a", { ...ev("Stop"), bantou_ts: 2000 }, "S1");
  assert.equal(t.apply("a", { ...ev("PostToolUse"), bantou_ts: 1000 }, "S1"), false);
  assert.equal(t.get("a", "S1", true).activity, "idle");
  assert.equal(t.apply("a", { ...ev("UserPromptSubmit"), bantou_ts: 3000 }, "S1"), true);
  // 起動し直した後は ts を比べない
  assert.equal(t.apply("a", { ...ev("SessionStart", { source: "startup" }), bantou_ts: 10 }, "S2"), true);
});

test("hook の設定: 全 event に async の center コマンド。statusLine と hooks のキーだけ。token は含まない", () => {
  const cmd = hookCommand(hookUrl("http://127.0.0.1:4567/mcp/session", "pm1"), ["/fake/bantou-center"], "linux");
  assert.equal(cmd, "'/fake/bantou-center' 'hook' '--url' 'http://127.0.0.1:4567/sessions/pm1/hook'");
  const s = JSON.parse(statusLineSettingsJson("sl", cmd)) as { hooks: Record<string, { hooks: { type: string; command: string; async: boolean }[] }[]> };
  assert.deepEqual(Object.keys(s).sort(), ["hooks", "statusLine"]);
  assert.deepEqual(Object.keys(s.hooks).sort(), [...HOOK_EVENTS].sort());
  for (const [name, g] of Object.entries(s.hooks)) {
    const sync = name === "Stop" || name === "StopFailure";
    assert.deepEqual(g[0].hooks[0], { type: "command", command: cmd, ...(sync ? {} : { async: true }), timeout: 10 });
  }
  assert.ok(!/token/i.test(cmd));
  assert.deepEqual(Object.keys(JSON.parse(statusLineSettingsJson("sl"))), ["statusLine"]);
});

test("addHookTimestamp / runHook: 発火時刻を足して Bearer token 付きで POST", async () => {
  assert.equal(JSON.parse(addHookTimestamp('{"a":1}', 5)).bantou_ts, 5);
  assert.equal(addHookTimestamp("oops", 5), "oops");
  const calls: RequestInit[] = [];
  async function* stdin(): AsyncGenerator<Buffer> {
    yield Buffer.from('{"hook_event_name":"Stop"}');
  }
  const rc = await runHook(["--url", "http://h/sessions/n/hook"], {
    env: { BANTOU_SESSION_TOKEN: "tok" },
    stdin: stdin(),
    fetchImpl: (async (_u: string, init: RequestInit) => (calls.push(init), new Response(null, { status: 204 }))) as unknown as typeof fetch,
  });
  assert.equal(rc, 0);
  const body = JSON.parse(calls[0].body as string);
  assert.equal(body.hook_event_name, "Stop");
  assert.equal(typeof body.bantou_ts, "number");
  assert.equal((calls[0].headers as Record<string, string>).authorization, "Bearer tok");
});

test("lastMessageFromHook: Stop の last_assistant_message だけ。他の event・空・壊れた入力は null", () => {
  assert.equal(lastMessageFromHook(ev("Stop", { last_assistant_message: "終わった" })), "終わった");
  assert.equal(lastMessageFromHook(ev("StopFailure", { last_assistant_message: "API Error" })), null);
  assert.equal(lastMessageFromHook(ev("UserPromptSubmit", { last_assistant_message: "x" })), null);
  assert.equal(lastMessageFromHook(ev("Stop")), null);
  assert.equal(lastMessageFromHook(ev("Stop", { last_assistant_message: "  \n" })), null);
  for (const v of [null, "x", [], 1]) assert.equal(lastMessageFromHook(v), null);
});

test("publishLastMessage: Stop が来るたびに session 名・本文・時刻つきで届いた順に流れる（状態が idle のままでも）", () => {
  const hub = createEventHub();
  const got: SessionMessage[] = [];
  const un = hub.subscribeMessage((m) => got.push(m));
  const at = (ms: number) => () => ms;
  publishLastMessage(hub, "a", ev("Stop", { last_assistant_message: "一つ目" }), at(Date.parse("2026-11-09T00:00:00Z")));
  publishLastMessage(hub, "b", ev("PostToolUse"), at(1)); // 流れない
  publishLastMessage(hub, "b", ev("Stop", { last_assistant_message: "bの返事" }), at(Date.parse("2026-11-09T00:00:05Z")));
  publishLastMessage(hub, "a", ev("Stop", { last_assistant_message: "二つ目" }), at(Date.parse("2026-11-09T00:00:09Z")));
  un();
  publishLastMessage(hub, "a", ev("Stop", { last_assistant_message: "解除後" }), at(0));
  assert.deepEqual(got, [
    { session: "a", text: "一つ目", at: "2026-11-09T00:00:00.000Z" },
    { session: "b", text: "bの返事", at: "2026-11-09T00:00:05.000Z" },
    { session: "a", text: "二つ目", at: "2026-11-09T00:00:09.000Z" },
  ]);
});
