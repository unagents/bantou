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
  assert.deepEqual(t.get("a", "S1", true), { activity: "unknown", activityAt: null, background: { subagents: 0, tasks: 0 } });
  assert.equal(t.apply("a", ev("UserPromptSubmit"), "S1"), true);
  assert.equal(t.apply("a", ev("PostToolUse"), "S1"), false, "同じ状態");
  assert.deepEqual(t.get("a", "S1", true), { activity: "working", activityAt: "2026-11-09T00:00:00.000Z", background: { subagents: 0, tasks: 0 } });
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

// --- (A) 作業の進行（subagent・background）と (B) cap の 3 状態は別の軸 ---------------------------------------------

const fresh = () => createSessionActivityTracker();
const view = (t: ReturnType<typeof fresh>) => t.get("a", "S1", true);

test("hook の設定に SubagentStart / SubagentStop が入る（Stop 系だけ同期）", () => {
  assert.ok(HOOK_EVENTS.includes("SubagentStart") && HOOK_EVENTS.includes("SubagentStop"));
  const cmd = hookCommand(hookUrl("http://127.0.0.1:4567/mcp/session", "pm1"), ["/fake/bantou-center"], "linux");
  const s = JSON.parse(statusLineSettingsJson("sl", cmd)) as { hooks: Record<string, { hooks: { async?: boolean }[] }[]> };
  assert.equal(s.hooks.SubagentStart![0]!.hooks[0]!.async, true);
  assert.equal(s.hooks.SubagentStop![0]!.hooks[0]!.async, true);
});

test("(A) subagent: Start で background.subagents が立ち、Stop（本体の turn 終了）後も、SubagentStop まで続く。cap は idle", () => {
  const t = fresh();
  t.apply("a", ev("UserPromptSubmit"), "S1");
  assert.equal(t.apply("a", ev("SubagentStart", { agent_id: "ag1", agent_type: "Explore" }), "S1"), true, "background の変化は通知する");
  assert.deepEqual(view(t).background, { subagents: 1, tasks: 0 });
  assert.equal(view(t).activity, "working");
  // 本体の turn が終わる。background の subagent は Stop の background_tasks にも居る
  t.apply("a", ev("Stop", { background_tasks: [{ id: "ag1", type: "subagent", status: "running", agent_type: "Explore" }] }), "S1");
  assert.equal(view(t).activity, "idle", "cap は待機（作業の進行に左右されない）");
  assert.deepEqual(view(t).background, { subagents: 1, tasks: 0 }, "subagent が動いている間は進行中");
  // subagent が終わるまで idle_prompt が来ても進行中は消えない
  t.apply("a", ev("Notification", { notification_type: "idle_prompt" }), "S1");
  assert.deepEqual(view(t).background, { subagents: 1, tasks: 0 });
  assert.equal(t.apply("a", ev("SubagentStop", { agent_id: "ag1", agent_type: "Explore", background_tasks: [] }), "S1"), true);
  assert.deepEqual(view(t).background, { subagents: 0, tasks: 0 });
  assert.equal(view(t).activity, "idle");
});

test("(A) background の subagent が tool を使っても、cap（本体）は待機のまま", () => {
  const t = fresh();
  t.apply("a", ev("Stop", { background_tasks: [{ id: "ag1", type: "subagent", status: "running" }] }), "S1");
  assert.equal(t.apply("a", ev("PreToolUse", { tool_name: "Bash", agent_id: "ag1" }), "S1"), false);
  assert.equal(t.apply("a", ev("PostToolUse", { tool_name: "Bash", agent_id: "ag1" }), "S1"), false);
  assert.equal(view(t).activity, "idle");
  assert.deepEqual(view(t).background, { subagents: 1, tasks: 0 });
});

test("(A) background の shell / monitor: Stop の background_tasks の件数が続く間、進行中。次の Stop で空になれば消える", () => {
  const t = fresh();
  t.apply("a", ev("UserPromptSubmit"), "S1");
  t.apply("a", ev("Stop", { background_tasks: [{ id: "t1", type: "shell", status: "running", command: "sleep 600" }, { id: "t2", type: "monitor", status: "running" }], session_crons: [] }), "S1");
  assert.equal(view(t).activity, "idle");
  assert.deepEqual(view(t).background, { subagents: 0, tasks: 2 });
  // 完了の通知で claude が起きて turn が走り、また終わる
  t.apply("a", ev("UserPromptSubmit"), "S1");
  assert.equal(view(t).activity, "working");
  assert.deepEqual(view(t).background, { subagents: 0, tasks: 2 }, "turn の間も進行中は残る");
  t.apply("a", ev("Stop", { background_tasks: [] }), "S1");
  assert.deepEqual(view(t), { activity: "idle", activityAt: view(t).activityAt, background: { subagents: 0, tasks: 0 } });
});

test("(A) background_tasks の無い Stop（古い claude）は background を変えない。SessionStart で捨てる。起動し直しでも捨てる", () => {
  const t = fresh();
  t.apply("a", ev("SubagentStart", { agent_id: "ag1" }), "S1");
  t.apply("a", ev("Stop"), "S1");
  assert.deepEqual(view(t).background, { subagents: 1, tasks: 0 });
  t.apply("a", ev("SessionStart", { source: "resume" }), "S1");
  assert.deepEqual(view(t).background, { subagents: 0, tasks: 0 });
  t.apply("a", ev("SubagentStart", { agent_id: "ag2" }), "S1");
  assert.deepEqual(t.get("a", "S2", true).background, { subagents: 0, tasks: 0 }, "起動し直し");
});

test("(A) Stop の snapshot が正: SubagentStop を取りこぼした subagent は、次の Stop で数え直される", () => {
  const t = fresh();
  t.apply("a", ev("SubagentStart", { agent_id: "lost" }), "S1");
  t.apply("a", ev("Stop", { background_tasks: [] }), "S1");
  assert.deepEqual(view(t).background, { subagents: 0, tasks: 0 });
});

test("(A) 並行する subagent は全部終わるまで進行中", () => {
  const t = fresh();
  t.apply("a", ev("SubagentStart", { agent_id: "x" }), "S1");
  t.apply("a", ev("SubagentStart", { agent_id: "y" }), "S1");
  assert.equal(view(t).background.subagents, 2);
  t.apply("a", ev("SubagentStop", { agent_id: "x" }), "S1");
  assert.equal(view(t).background.subagents, 1);
  t.apply("a", ev("SubagentStop", { agent_id: "y" }), "S1");
  assert.equal(view(t).background.subagents, 0);
});

test("(B) cap の 3 状態: 返答待ち / 待機 / 本体が実行中（入力に反応できない）。background の有無に左右されない", () => {
  const bg = { background_tasks: [{ id: "t1", type: "shell", status: "running" }] };
  for (const withBackground of [false, true]) {
    const t = fresh();
    const extra = withBackground ? bg : {};
    t.apply("a", ev("Stop", extra), "S1");
    assert.equal(view(t).activity, "idle", "待機");
    t.apply("a", ev("UserPromptSubmit"), "S1");
    assert.equal(view(t).activity, "working", "本体が実行中");
    t.apply("a", ev("PermissionRequest", { tool_name: "Bash" }), "S1");
    assert.equal(view(t).activity, "needs-input", "返答待ち");
    t.apply("a", ev("PostToolUse", { tool_name: "Bash" }), "S1");
    assert.equal(view(t).activity, "working", "返答が済んで実行に戻る");
    t.apply("a", ev("PreToolUse", { tool_name: "AskUserQuestion" }), "S1");
    assert.equal(view(t).activity, "needs-input");
    t.apply("a", ev("Stop", extra), "S1");
    assert.equal(view(t).activity, "idle");
  }
});

test("(B) subagent の許可待ちは返答待ち。返答が済んで subagent の tool が動けば、本体の状態に戻る", () => {
  const t = fresh();
  t.apply("a", ev("UserPromptSubmit"), "S1");
  t.apply("a", ev("PermissionRequest", { tool_name: "Bash", agent_id: "ag1" }), "S1");
  assert.equal(view(t).activity, "needs-input");
  t.apply("a", ev("PostToolUse", { tool_name: "Bash", agent_id: "ag1" }), "S1");
  assert.equal(view(t).activity, "working", "本体の turn は続いている");
});

test("tracker: SessionStart の compact は何も変えない。壊れた入力・未対応 event は false", () => {
  const t = fresh();
  t.apply("a", ev("UserPromptSubmit"), "S1");
  assert.equal(t.apply("a", ev("SessionStart", { source: "compact" }), "S1"), false);
  assert.equal(view(t).activity, "working");
  for (const v of [null, "x", [], 1, ev("SessionEnd"), ev("Foo")]) assert.equal(t.apply("a", v, "S1"), false);
});

// --- subagent の数え方: Stop / SubagentStop の background_tasks が正本、Start / Stop は agent_id 単位の補助 ---------------

const subTask = (id: string) => ({ id, type: "subagent", status: "running", agent_type: "general-purpose" });

test("(a) Stop の snapshot に居る subagent に、別の SubagentStart / SubagentStop が重なっても、先に動いていた subagent は数え続ける", () => {
  const t = fresh();
  t.apply("a", ev("Stop", { background_tasks: [subTask("X")] }), "S1");
  assert.equal(view(t).background.subagents, 1);
  t.apply("a", ev("SubagentStart", { agent_id: "a", agent_type: "Explore" }), "S1");
  assert.equal(view(t).background.subagents, 2, "snapshot の 1 + 後から始まった 1");
  // a が終わる。snapshot には X だけが残る
  t.apply("a", ev("SubagentStop", { agent_id: "a", agent_type: "Explore", background_tasks: [subTask("X")] }), "S1");
  assert.equal(view(t).background.subagents, 1, "X が動いているので進行中のまま");
  // snapshot が終わった subagent 自身（agent_id と同じ id）を含んでいても数えない
  t.apply("a", ev("SubagentStart", { agent_id: "b" }), "S1");
  t.apply("a", ev("SubagentStop", { agent_id: "b", background_tasks: [subTask("X"), subTask("b")] }), "S1");
  assert.equal(view(t).background.subagents, 1);
  // snapshot の無い SubagentStop（古い claude）でも、Start を見ていない agent の Stop は X を減らさない
  t.apply("a", ev("SubagentStop", { agent_id: "ghost" }), "S1");
  assert.equal(view(t).background.subagents, 1);
});

test("(b) SubagentStart だけで SubagentStop が来なくても（resume・teammate の message 処理）、次の Stop / SubagentStop の snapshot で数え直される", () => {
  const t = fresh();
  t.apply("a", ev("SubagentStart", { agent_id: "teammate", agent_type: "teammate" }), "S1");
  assert.equal(view(t).background.subagents, 1, "Stop が来るまでは動いているとみなす");
  t.apply("a", ev("Stop", { background_tasks: [] }), "S1");
  assert.equal(view(t).background.subagents, 0, "Stop の snapshot が正");
  t.apply("a", ev("SubagentStart", { agent_id: "resumed" }), "S1");
  t.apply("a", ev("SubagentStart", { agent_id: "other" }), "S1");
  t.apply("a", ev("SubagentStop", { agent_id: "other", background_tasks: [] }), "S1");
  assert.equal(view(t).background.subagents, 0, "SubagentStop の snapshot（親 session 全体の in-flight）が正");
});

test("(c) Start の無い SubagentStop（内部 agent: prompt suggestions・/btw）は、動いている他の subagent の数を減らさない", () => {
  const t = fresh();
  t.apply("a", ev("Stop", { background_tasks: [subTask("X"), subTask("Y")] }), "S1");
  assert.equal(view(t).background.subagents, 2);
  // 内部 agent の SubagentStop。snapshot には X・Y が居る / 古い claude では snapshot が無い
  t.apply("a", ev("SubagentStop", { agent_id: "internal", agent_type: "", background_tasks: [subTask("X"), subTask("Y")] }), "S1");
  assert.equal(view(t).background.subagents, 2);
  t.apply("a", ev("SubagentStop", { agent_id: "internal2", agent_type: "" }), "S1");
  assert.equal(view(t).background.subagents, 2);
  assert.equal(view(t).activity, "idle");
});

test("(c) background の shell も、subagent の SubagentStop の snapshot で置き換わる（subagent の数は変えない）", () => {
  const t = fresh();
  t.apply("a", ev("Stop", { background_tasks: [subTask("X"), { id: "sh", type: "shell", status: "running" }] }), "S1");
  t.apply("a", ev("SubagentStop", { agent_id: "internal", background_tasks: [subTask("X")] }), "S1");
  assert.deepEqual(view(t).background, { subagents: 1, tasks: 0 }, "shell が終わった後の snapshot");
});

test("hook 設定が起動時に作られる既存 session（SubagentStart / Stop が来ない）でも、Stop の snapshot で作業進行中が分かる", () => {
  // hook の設定は claude の起動時に `--settings` で渡される。center を更新した後も、動いたままの session は旧 event の組（SubagentStart / Stop 無し）のまま
  const t = fresh();
  t.apply("a", ev("UserPromptSubmit"), "S1");
  t.apply("a", ev("PostToolUse", { tool_name: "Agent" }), "S1");
  t.apply("a", ev("Stop", { background_tasks: [subTask("X"), { id: "sh", type: "shell", status: "running" }] }), "S1");
  assert.equal(view(t).activity, "idle");
  assert.deepEqual(view(t).background, { subagents: 1, tasks: 1 }, "Stop の snapshot だけで進行中");
  // 次の turn が終わって空になれば消える
  t.apply("a", ev("UserPromptSubmit"), "S1");
  t.apply("a", ev("Stop", { background_tasks: [] }), "S1");
  assert.deepEqual(view(t).background, { subagents: 0, tasks: 0 });
});
