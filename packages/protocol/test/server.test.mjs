import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  isServerCommand, isKickCapCommand, isStopCapCommand, isResumeWorkerCommand, isStatusCommand,
  parseServerCommand, isServerReply, parseServerReply,
  isActivityState, isServerNotice, parseServerNotice, ACTIVITY_STATES,
  isValidAgentId, isAgentState, SERVER_NAME, MESSENGER_PROTOCOL, AGENT_ID_PATTERN,
  isHelloCommand, isUpdateServerCommand, isValidServerVersion, isErrorCode, ERROR_CODES,
  FOLLOW_MIN_PROTOCOL, SERVER_VERSION_PATTERN, SERVER_ID_PATTERN, MODEL_PATTERN, isValidModel,
  isTaskCommand, isWorkerReplyCommand, isWorkerRole, isWorkerReportKind,
  isRegisterChangeCommand,
  isRetireServerCommand, supportsRetire, isProtocolCompatible, RETIRE_MIN_PROTOCOL, RETIRE_EXIT_CODE,
} from "../dist/index.js";

const activityAgent = {
  kind: "worker", id: "w-1", cap_id: "r-1", state: "running", task: "do it", last_activity: "Bash: ls",
  last_output_at: "2026-10-29T00:00:00.000Z", silent_ms: 1200, started_at: "2026-10-29T00:00:00.000Z", finished_at: null,
};
const activityNotice = {
  bantou: 1, type: "activity", cap_id: "r-1", at: "2026-10-29T00:00:05.000Z",
  agents: [{ ...activityAgent, kind: "cap", id: "r-1", state: "idle", last_activity: null, last_output_at: null }, activityAgent],
};
const kickMin = { bantou: 1, type: "kick_cap", cap_id: "c1", prompt: "go" };
const kickFull = {
  bantou: 1, type: "kick_cap", cap_id: "my-cap_2", prompt: "do it",
  repo: "git@github.com:unagents/bantou.git", branch: "develop", reason: "nightly",
};
const resumeMin = { bantou: 1, type: "resume_worker", worker_id: "w1", prompt: "continue" };
const resumeRepo = { ...resumeMin, repo: "https://example.com/r.git", branch: "main" };
const status = { bantou: 1, type: "status" };
const stopCap = { bantou: 1, type: "stop_cap", cap_id: "c1" };
const hello = { bantou: 1, type: "hello" };
const updateServer = { bantou: 1, type: "update_server", version: "0.3.1" };
const running = { caps: 1, workers: 2, reports: 0 };
const helloResult = {
  bantou: 1, type: "hello_result", ok: true, server_version: "0.3.0", protocol_version: "1.4.0",
  update: { state: "waiting", from: "0.3.0", to: "0.3.1", running },
  last_update: { to: "0.3.2", ok: false, error: "npx failed", at: "2026-10-31T00:00:00.000Z" },
};
const updateResult = { bantou: 1, type: "update_result", ok: true, state: "waiting", from: "0.3.0", to: "0.3.1", running };
const updatingErr = {
  bantou: 1, type: "error", ok: false, message: "server 更新待ち", command: "kick_cap", cap_id: "c1",
  code: "updating", retryable: true,
};
const stopResult = { bantou: 1, type: "stop_result", ok: true, cap_id: "c1", stopped: true };

const taskMin = {
  bantou: 1, type: "task", cap_id: "c1", task_id: "t-1", goal: "do it",
  deliverables: {}, verify: {}, constraints: [], workers: {},
};
const taskFull = {
  bantou: 1, type: "task", cap_id: "c1", task_id: "t-1", goal: "add the task message",
  repo: "https://github.com/unagents/bantou.git", branch: "feature/protocol-task",
  deliverables: { branch: "feature/x", report_path: "docs/history/x/report.md", other: ["PR description"] },
  verify: { tests: ["npm test"], steps: ["read the diff"] },
  constraints: ["no version bump"],
  workers: { items: [
    { id: "impl", role: "implement", scope: "server", model: "sonnet" },
    { role: "review", scope: "server diff", depends_on: ["impl"] },
  ] },
  worker_model: "sonnet",
};
const taskResult = {
  bantou: 1, type: "task_result", cap_id: "c1", task_id: "t-1", state: "done", summary: "ok",
  workers: [{ worker_id: "w-1", role: "implement", state: "done", branch: "feature/x", commit: "abc1234", tests: "npm test: 41 pass", report_path: "r.md", result: "done" }],
  review: { verdict: "issues", items: [{ severity: "high", text: "missing guard", resolved: true }], rounds: 1 },
  remaining: ["docs"], error: "x",
};
const workerReply = { bantou: 1, type: "worker_reply", cap_id: "c1", worker_id: "w-1", text: "fix it" };
const workerReplyResult = { bantou: 1, type: "worker_reply_result", ok: true, cap_id: "c1", worker_id: "w-1", accepted: true };
const workerReport = { bantou: 1, type: "worker_report", cap_id: "c1", task_id: "t-1", worker_id: "w-1", kind: "ask", text: "which branch?", at: "2026-11-04T00:00:00.000Z" };

test("server name", () => {
  assert.equal(SERVER_NAME, "bantou-server");
});

test("isServerCommand accepts valid commands", () => {
  assert.ok(isServerCommand(kickMin) && isKickCapCommand(kickMin) && !isResumeWorkerCommand(kickMin));
  assert.ok(isServerCommand(kickFull) && isKickCapCommand(kickFull));
  assert.ok(isServerCommand(resumeMin) && isResumeWorkerCommand(resumeMin) && !isStatusCommand(resumeMin));
  assert.ok(isServerCommand(resumeRepo) && isResumeWorkerCommand(resumeRepo));
  assert.ok(isServerCommand(status) && isStatusCommand(status) && !isKickCapCommand(status));
});

test("isServerCommand rejects invalid input", () => {
  assert.equal(isServerCommand(null), false);
  assert.equal(isServerCommand([]), false);
  assert.equal(isServerCommand({ ...kickMin, bantou: 2 }), false);
  assert.equal(isServerCommand({ ...status, bantou: 2 }), false);
  assert.equal(isServerCommand({ bantou: 1, type: "nope" }), false);
  assert.equal(isServerCommand({ bantou: 1, type: "launch_session", name: "s1" }), false);
  assert.equal(isServerCommand({ bantou: 1, type: "list_sessions" }), false);
  for (const id of ["a b", "a.b", "../x", ""]) {
    assert.equal(isServerCommand({ ...kickMin, cap_id: id }), false, `cap_id=${JSON.stringify(id)}`);
    assert.equal(isServerCommand({ ...resumeMin, worker_id: id }), false, `worker_id=${JSON.stringify(id)}`);
  }
  assert.equal(isServerCommand({ ...kickMin, prompt: "" }), false);
  assert.equal(isServerCommand({ ...kickMin, prompt: undefined }), false);
  assert.equal(isServerCommand({ ...resumeMin, prompt: "" }), false);
  assert.equal(isServerCommand({ ...kickMin, reason: 1 }), false);
  for (const base of [kickMin, resumeMin]) {
    assert.equal(isServerCommand({ ...base, repo: "-x" }), false);
    assert.equal(isServerCommand({ ...base, repo: "a\0b" }), false);
    assert.equal(isServerCommand({ ...base, repo: "" }), false);
    assert.equal(isServerCommand({ ...base, branch: "--foo" }), false);
    assert.equal(isServerCommand({ ...base, branch: "" }), false);
  }
});

test("parseServerCommand", () => {
  assert.equal(parseServerCommand("hello"), undefined);
  assert.equal(parseServerCommand('{"a":1}'), undefined);
  assert.equal(
    parseServerCommand(JSON.stringify({ bantou: 1, type: "task", task_id: "t1", title: "x" })),
    undefined,
  );
  assert.deepEqual(parseServerCommand(` ${JSON.stringify(kickFull)}\n`), kickFull);
  assert.deepEqual(parseServerCommand(JSON.stringify(status)), status);
});

const agent = {
  kind: "cap", id: "c1", path: "/w/caps/c1", session_id: "sid", state: "idle",
  last_started_at: "2026-10-27T10:00:00Z", last_finished_at: null, retries: 0, queued: 0,
};
const capResult = { bantou: 1, type: "cap_result", cap_id: "c1", session_id: "sid", ok: true, result_text: "done" };
const workerResult = {
  bantou: 1, type: "worker_result", worker_id: "w1", session_id: "sid",
  ok: false, result_text: "", error: "boom",
};
const statusReply = {
  bantou: 1, type: "status_result", ok: true,
  caps: [agent],
  workers: [{ ...agent, kind: "worker", id: "w1", session_id: null, state: "failed", last_error: "x", queued: 2 }],
};
const errReply = { bantou: 1, type: "error", ok: false, message: "boom", command: "kick_cap" };

test("isServerReply accepts the four reply shapes", () => {
  assert.ok(isServerReply(capResult));
  assert.ok(isServerReply(workerResult));
  assert.ok(isServerReply(statusReply));
  assert.ok(isServerReply({ ...statusReply, caps: [], workers: [] }));
  assert.ok(isServerReply(errReply));
  assert.ok(isServerReply({ bantou: 1, type: "error", ok: false, message: "boom" }));
  assert.ok(isServerReply({ ...errReply, cap_id: "c1" }));
  assert.ok(isServerReply({ ...errReply, command: "resume_worker", worker_id: "w1" }));
});

test("isServerReply rejects mismatches", () => {
  assert.equal(isServerReply({ ...errReply, ok: true }), false);
  assert.equal(isServerReply({ ...statusReply, ok: false }), false);
  assert.equal(isServerReply({ ...errReply, command: "nope" }), false);
  assert.equal(isServerReply({ ...errReply, message: 1 }), false);
  assert.equal(isServerReply({ ...errReply, cap_id: "a b" }), false);
  assert.equal(isServerReply({ ...errReply, worker_id: 1 }), false);
  assert.equal(isServerReply({ ...capResult, bantou: 2 }), false);
  assert.equal(isServerReply({ ...capResult, session_id: undefined }), false);
  assert.equal(isServerReply({ ...capResult, cap_id: "a b" }), false);
  assert.equal(isServerReply({ ...workerResult, worker_id: undefined }), false);
  assert.equal(isServerReply({ ...capResult, ok: "yes" }), false);
  assert.equal(isServerReply({ bantou: 1, type: "session_launched", ok: true }), false);
  assert.equal(isServerReply({ ...statusReply, caps: [{ ...agent, state: "bogus" }] }), false);
  assert.equal(isServerReply({ ...statusReply, caps: [{ ...agent, kind: "x" }] }), false);
  assert.equal(isServerReply({ ...statusReply, caps: [{ ...agent, retries: "0" }] }), false);
  assert.equal(isServerReply({ ...statusReply, caps: [null] }), false);
  assert.equal(isServerReply({ ...statusReply, workers: "x" }), false);
});

test("parseServerReply", () => {
  assert.equal(parseServerReply("hello"), undefined);
  assert.equal(parseServerReply('{"a":1}'), undefined);
  assert.deepEqual(parseServerReply(`${JSON.stringify(statusReply)}\n`), statusReply);
});

test("isValidAgentId", () => {
  assert.ok(isValidAgentId("abc-DEF_09"));
  for (const n of ["", "a b", "a.b", "a:b", "../x", 1, null, undefined]) {
    assert.equal(isValidAgentId(n), false);
  }
});

test("isAgentState", () => {
  for (const s of ["idle", "running", "failed", "error"]) assert.ok(isAgentState(s));
  for (const s of ["done", "", 1, null, undefined]) assert.equal(isAgentState(s), false);
});

test("prompt / reason に NUL を含む指示は拒否", () => {
  assert.equal(isServerCommand({ ...kickMin, prompt: "a\0b" }), false);
  assert.equal(isServerCommand({ ...kickMin, reason: "a\0b" }), false);
  assert.equal(isServerCommand({ ...resumeMin, prompt: "a\0b" }), false);
});

const manifest = JSON.parse(readFileSync(new URL("../messenger/protocol.json", import.meta.url), "utf8"));

test("messenger/protocol.json matches MESSENGER_PROTOCOL and the message set", () => {
  assert.equal(manifest.name, MESSENGER_PROTOCOL.protocol);
  assert.equal(manifest.version, MESSENGER_PROTOCOL.version);
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  assert.equal(typeof manifest.description, "string");
  assert.deepEqual(Object.keys(manifest.messages).sort(), ["activity", "cap_result", "error", "hello", "hello_result", "kick_cap", "retire_result", "retire_server", "status", "status_result", "stop_cap", "stop_result", "task", "task_result", "update_result", "update_server", "worker_reply", "worker_reply_result", "worker_report"]);
  for (const [k, schema] of Object.entries(manifest.messages)) {
    assert.equal(schema.type, "object", k);
    assert.equal(schema.properties.type.const, k, k);
    assert.equal(schema.properties.bantou.const, 1, k);
  }
});

test("protocol.json required fields agree with the guards", () => {
  const m = manifest.messages;
  // every sample accepted by the guards carries all required fields of its schema
  const samples = { task: taskFull, task_result: taskResult, worker_reply: workerReply, worker_reply_result: workerReplyResult, worker_report: workerReport, activity: activityNotice, kick_cap: kickMin, stop_cap: stopCap, stop_result: stopResult, status, cap_result: capResult, status_result: statusReply, error: errReply, hello, hello_result: helloResult, update_server: updateServer, update_result: updateResult };
  for (const [k, v] of Object.entries(samples)) {
    for (const f of m[k].required) assert.ok(f in v, `${k} sample lacks required ${f}`);
    for (const f of Object.keys(v)) assert.ok(f in m[k].properties, `${k}.${f} not in schema`);
  }
  assert.deepEqual([...m.kick_cap.required].sort(), ["bantou", "cap_id", "prompt", "type"]);
  for (const f of Object.keys(kickFull)) assert.ok(f in m.kick_cap.properties, f);
  assert.equal(m.kick_cap.properties.cap_id.pattern, AGENT_ID_PATTERN.source);
});

test("stop_cap / stop_result", () => {
  assert.ok(isServerCommand(stopCap) && isStopCapCommand(stopCap) && !isKickCapCommand(stopCap));
  assert.deepEqual(parseServerCommand(JSON.stringify(stopCap)), stopCap);
  for (const id of ["", "a b", "../x", undefined, 1]) {
    assert.equal(isServerCommand({ ...stopCap, cap_id: id }), false, String(id));
  }
  assert.ok(isServerReply(stopResult));
  assert.deepEqual(parseServerReply(JSON.stringify(stopResult)), stopResult);
  assert.equal(isServerReply({ ...stopResult, stopped: "yes" }), false);
  assert.equal(isServerReply({ ...stopResult, ok: false }), false);
  assert.equal(isServerReply({ ...stopResult, cap_id: "a b" }), false);
  assert.ok(isServerReply({ bantou: 1, type: "error", ok: false, message: "x", command: "stop_cap", cap_id: "c1" }));
  assert.deepEqual(manifest.messages.error.properties.command.enum, ["kick_cap", "resume_worker", "stop_cap", "status", "hello", "update_server", "task", "worker_reply", "retire_server"]);
  assert.equal(MESSENGER_PROTOCOL.version, "1.8.1");
});

test("model: kick_cap の model / worker_model は省略可、形式を検証、知らない版は無視できる", () => {
  for (const m of ["sonnet", "opus", "haiku", "claude-sonnet-5-5", "opus[1m]", "a.b_c-d"]) {
    assert.ok(isValidModel(m), m);
    assert.ok(isKickCapCommand({ ...kickMin, model: m, worker_model: m }), m);
  }
  for (const m of ["", "-x", "--model", "a b", "a;b", "a\n", "a/b", 1, null]) {
    assert.equal(isValidModel(m), false, String(m));
    assert.equal(isServerCommand({ ...kickMin, model: m }), false, `model ${String(m)}`);
    assert.equal(isServerCommand({ ...kickMin, worker_model: m }), false, `worker_model ${String(m)}`);
  }
  assert.ok(isKickCapCommand(kickMin)); // 省略
  assert.equal(MODEL_PATTERN.source, manifest.messages.kick_cap.properties.model.pattern);
  assert.equal(MODEL_PATTERN.source, manifest.messages.kick_cap.properties.worker_model.pattern);
  // 古い相手: model を知らない相手の返信（agents に model 無し）も通り、知らない項目は無視される
  assert.ok(isServerNotice({ ...activityNotice, extra: 1 }));
  assert.ok(isServerNotice({ ...activityNotice, agents: activityNotice.agents.map((a) => ({ ...a, model: "opus" })) }));
  assert.ok(isServerNotice({ ...activityNotice, agents: activityNotice.agents.map((a) => ({ ...a, model: null })) }));
  assert.equal(isServerNotice({ ...activityNotice, agents: activityNotice.agents.map((a) => ({ ...a, model: 5 })) }), false);
  const st = { kind: "cap", id: "c1", path: "/p", session_id: null, state: "idle", last_started_at: null, last_finished_at: null, retries: 0, queued: 0 };
  const stReply = (extra) => ({ bantou: 1, type: "status_result", ok: true, caps: [{ ...st, ...extra }], workers: [] });
  assert.ok(isServerReply(stReply({})));
  assert.ok(isServerReply(stReply({ model: "sonnet" })));
  assert.ok(isServerReply(stReply({ model: null })));
  assert.equal(isServerReply(stReply({ model: 1 })), false);
});

test("activity notice guard", () => {
  assert.deepEqual([...ACTIVITY_STATES], ["running", "stalled", "idle", "done", "failed", "lost"]);
  for (const st of ACTIVITY_STATES) assert.ok(isActivityState(st), st);
  assert.equal(isActivityState("error"), false);
  assert.ok(isServerNotice(activityNotice));
  assert.deepEqual(parseServerNotice(JSON.stringify(activityNotice)), activityNotice);
  assert.ok(isServerNotice({ ...activityNotice, agents: [] }));
  assert.ok(isServerNotice({ ...activityNotice, agents: [{ ...activityAgent, state: "lost", error: "signal SIGKILL" }] }));
  assert.equal(isServerNotice({ ...activityNotice, agents: [{ ...activityAgent, state: "dead" }] }), false);
  assert.equal(isServerNotice({ ...activityNotice, agents: [{ ...activityAgent, silent_ms: "1" }] }), false);
  assert.equal(isServerNotice({ ...activityNotice, agents: [{ ...activityAgent, id: "a b" }] }), false);
  assert.equal(isServerNotice({ ...activityNotice, cap_id: "a b" }), false);
  assert.equal(isServerNotice({ ...activityNotice, at: 1 }), false);
  assert.equal(isServerNotice({ ...activityNotice, bantou: 2 }), false);
  assert.equal(isServerNotice({ ...activityNotice, agents: "x" }), false);
  assert.equal(parseServerNotice("nope"), undefined);
  assert.equal(parseServerNotice(JSON.stringify(capResult)), undefined);
});

test("an activity notice is not a reply or a command", () => {
  assert.equal(isServerReply(activityNotice), false);
  assert.equal(parseServerReply(JSON.stringify(activityNotice)), undefined);
  assert.equal(isServerCommand(activityNotice), false);
  assert.equal(isServerNotice(capResult), false);
});

test("hello / update_server / hello_result / update_result", () => {
  assert.ok(isServerCommand(hello) && isHelloCommand(hello) && !isUpdateServerCommand(hello));
  assert.ok(isServerCommand(updateServer) && isUpdateServerCommand(updateServer) && !isHelloCommand(updateServer));
  assert.deepEqual(parseServerCommand(JSON.stringify(updateServer)), updateServer);
  for (const v of ["", "1", "1.2", "latest", "-1.0.0", "1.0.0 --x", "1.0.0\n", "a.b.c", 1, null, undefined]) {
    assert.equal(isServerCommand({ ...updateServer, version: v }), false, String(v));
  }
  for (const v of ["0.3.1", "10.20.30", "0.0.0-e2e.1", "1.0.0-rc.1"]) assert.ok(isValidServerVersion(v), v);
  assert.equal(SERVER_VERSION_PATTERN.source, manifest.messages.update_server.properties.version.pattern);
  assert.equal(FOLLOW_MIN_PROTOCOL, "1.3.0");
  assert.ok(isServerReply(helloResult));
  assert.deepEqual(parseServerReply(JSON.stringify(helloResult)), helloResult);
  assert.ok(isServerReply({ ...helloResult, update: null, last_update: null }));
  assert.equal(isServerReply({ ...helloResult, update: undefined }), false);
  assert.equal(isServerReply({ ...helloResult, update: { ...helloResult.update, state: "x" } }), false);
  // 待っている run の phase は未知の値（後の版で足したもの）も受け入れる。hello_result 全体を捨てない。kind / id / 型の違う phase は不正
  const run = { kind: "cap", id: "c-1", started_at: "2026-11-21T05:00:00.000Z", phase: "running" };
  const withRuns = (runs) => ({ ...helloResult, update: { ...helloResult.update, since: "2026-11-21T05:00:00.000Z", deadline: "2026-11-21T05:30:00.000Z", runs } });
  assert.ok(isServerReply(withRuns([run, { ...run, phase: "queued" }, { ...run, phase: "preparing" }])));
  assert.ok(isServerReply(withRuns([{ ...run, phase: "suspended" }])), "未知の phase");
  assert.deepEqual(parseServerReply(JSON.stringify(withRuns([{ ...run, phase: "suspended" }])))?.update?.runs?.[0]?.phase, "suspended");
  assert.ok(isServerReply({ ...updateResult, runs: [{ ...run, phase: "suspended" }] }), "update_result も同じ");
  assert.ok(isServerReply({ bantou: 1, type: "error", ok: false, message: "m", code: "updating", update: withRuns([{ ...run, phase: "suspended" }]).update }), "error の update も同じ");
  assert.equal(isServerReply(withRuns([{ ...run, phase: 1 }])), false);
  assert.equal(isServerReply(withRuns([{ ...run, phase: undefined }])), false);
  assert.equal(isServerReply(withRuns([{ ...run, kind: "x" }])), false);
  assert.equal(isServerReply(withRuns([{ ...run, id: 1 }])), false);
  assert.equal(isServerReply(withRuns("x")), false);
  assert.equal(isServerReply({ ...helloResult, last_update: { ...helloResult.last_update, ok: true } }), false);
  assert.equal(isServerReply({ ...helloResult, server_version: 1 }), false);
  assert.ok(isServerReply(updateResult));
  assert.ok(isServerReply({ ...updateResult, state: "current" }) && isServerReply({ ...updateResult, state: "restarting" }));
  assert.equal(isServerReply({ ...updateResult, state: "done" }), false);
  assert.equal(isServerReply({ ...updateResult, running: { caps: 1 } }), false);
  assert.equal(isServerReply({ ...updateResult, ok: false }), false);
});

test("error code / retryable", () => {
  assert.ok(isServerReply(updatingErr));
  for (const c of ERROR_CODES) assert.ok(isErrorCode(c) && isServerReply({ ...updatingErr, code: c }), c);
  assert.deepEqual([...ERROR_CODES], manifest.messages.error.properties.code.enum);
  assert.equal(isServerReply({ ...updatingErr, code: "nope" }), false);
  assert.equal(isServerReply({ ...updatingErr, retryable: "yes" }), false);
  assert.ok(isServerReply({ ...updatingErr, command: "update_server", code: "update_failed", retryable: false }));
  assert.ok(isServerReply({ bantou: 1, type: "error", ok: false, message: "x" }));
});

test("protocol version 1.8.1 (1.8.0 retire_server; 1.7.0 added server identity, 1.6.0 status cap_id)", () => {
  assert.equal(MESSENGER_PROTOCOL.version, "1.8.1");
  assert.equal(manifest.version, "1.8.1");
});

test("status accepts an optional cap_id (1.6.0)", () => {
  assert.ok(isStatusCommand({ ...status, cap_id: "c-0a1b2c3d4e" }));
  assert.deepEqual(parseServerCommand(JSON.stringify({ ...status, cap_id: "c1" })), { ...status, cap_id: "c1" });
  for (const id of ["", "a b", "../x", 1, null]) assert.equal(isServerCommand({ ...status, cap_id: id }), false, String(id));
  assert.ok("cap_id" in manifest.messages.status.properties);
  assert.deepEqual(manifest.messages.status.required, ["bantou", "type"]);
  assert.equal(manifest.messages.status.properties.cap_id.pattern, AGENT_ID_PATTERN.source);
});

test("task command guard", () => {
  assert.ok(isServerCommand(taskMin) && isTaskCommand(taskMin) && !isKickCapCommand(taskMin));
  assert.ok(isTaskCommand(taskFull));
  assert.deepEqual(parseServerCommand(JSON.stringify(taskFull)), taskFull);
  const bad = [
    { ...taskMin, task_id: "a b" }, { ...taskMin, task_id: undefined }, { ...taskMin, cap_id: "../x" },
    { ...taskMin, goal: "" }, { ...taskMin, goal: "a\0b" }, { ...taskMin, deliverables: undefined }, { ...taskMin, verify: [] },
    { ...taskMin, constraints: undefined }, { ...taskMin, constraints: [1] }, { ...taskMin, workers: undefined },
    { ...taskMin, repo: "-x" }, { ...taskMin, branch: "-x" }, { ...taskMin, worker_model: "-x" },
    { ...taskMin, deliverables: { branch: "-x" } }, { ...taskMin, deliverables: { other: "x" } }, { ...taskMin, verify: { tests: [1] } },
    { ...taskMin, workers: { items: [{ role: "boss", scope: "x" }] } },
    { ...taskMin, workers: { items: [{ role: "review", scope: "" }] } },
    { ...taskMin, workers: { items: [{ role: "review", scope: "x", model: "-x" }] } },
    { ...taskMin, workers: { items: [{ role: "review", scope: "x", depends_on: ["a b"] }] } },
    { ...taskMin, workers: { items: {} } },
  ];
  for (const b of bad) assert.equal(isServerCommand(b), false, JSON.stringify(b));
  for (const r of ["implement", "review", "docs", "test", "other"]) assert.ok(isWorkerRole(r));
  assert.equal(isWorkerRole("boss"), false);
});

test("worker_reply command guard", () => {
  assert.ok(isServerCommand(workerReply) && isWorkerReplyCommand(workerReply) && !isTaskCommand(workerReply));
  for (const b of [{ ...workerReply, cap_id: "" }, { ...workerReply, worker_id: "a b" }, { ...workerReply, text: "" }, { ...workerReply, text: undefined }]) {
    assert.equal(isServerCommand(b), false, JSON.stringify(b));
  }
});

test("task_result / worker_reply_result reply guard", () => {
  assert.ok(isServerReply(taskResult));
  const min = { ...taskResult, workers: [], remaining: [], review: { verdict: "unknown", items: [], rounds: 0 }, error: undefined };
  assert.ok(isServerReply(min));
  assert.deepEqual(parseServerReply(JSON.stringify(taskResult)), taskResult);
  const bad = [
    { ...taskResult, state: "idle" }, { ...taskResult, task_id: "a b" }, { ...taskResult, summary: 1 },
    { ...taskResult, workers: [{ ...taskResult.workers[0], role: "boss" }] }, { ...taskResult, workers: [{ ...taskResult.workers[0], state: "x" }] },
    { ...taskResult, workers: [{ ...taskResult.workers[0], result: undefined }] },
    { ...taskResult, review: { ...taskResult.review, verdict: "maybe" } }, { ...taskResult, review: { ...taskResult.review, rounds: -1 } },
    { ...taskResult, review: { ...taskResult.review, rounds: 1.5 } }, { ...taskResult, review: undefined },
    { ...taskResult, review: { ...taskResult.review, items: [{ severity: "fatal", text: "x", resolved: true }] } },
    { ...taskResult, review: { ...taskResult.review, items: [{ severity: "low", text: "x" }] } },
    { ...taskResult, remaining: [1] }, { ...taskResult, remaining: undefined },
  ];
  for (const b of bad) assert.equal(isServerReply(b), false, JSON.stringify(b));
  assert.ok(isServerReply(workerReplyResult));
  assert.equal(isServerReply({ ...workerReplyResult, accepted: false }), false);
  assert.equal(isServerReply({ ...workerReplyResult, ok: false }), false);
  const err = { bantou: 1, type: "error", ok: false, message: "m", command: "task", cap_id: "c1", task_id: "t-1" };
  assert.ok(isServerReply(err));
  assert.ok(isServerReply({ ...err, command: "worker_reply", worker_id: "w-1" }));
  assert.equal(isServerReply({ ...err, task_id: "a b" }), false);
});

test("worker_report notice guard", () => {
  assert.ok(isServerNotice(workerReport));
  assert.ok(isServerNotice({ ...workerReport, task_id: undefined }));
  assert.deepEqual(parseServerNotice(JSON.stringify(workerReport)), workerReport);
  for (const k of ["progress", "ask", "approve", "done"]) assert.ok(isWorkerReportKind(k));
  for (const b of [{ ...workerReport, kind: "x" }, { ...workerReport, worker_id: "a b" }, { ...workerReport, text: 1 }, { ...workerReport, at: undefined }, { ...workerReport, task_id: "a b" }]) {
    assert.equal(isServerNotice(b), false, JSON.stringify(b));
  }
  assert.equal(isServerReply(workerReport), false);
  assert.equal(isServerCommand(workerReport), false);
});

const identity = { server_id: "srv-0a1b2c3d4e", host: "lenovo", user: "vagrant", workspace: "/home/vagrant/bantou-ws" };

test("server identity (1.7.0): hello_result / status_result carry optional server_id, host, user, workspace", () => {
  const h = { ...helloResult, ...identity };
  assert.ok(isServerReply(h));
  assert.deepEqual(parseServerReply(JSON.stringify(h)), h);
  const st = { ...statusReply, ...identity, server_version: "0.6.2", protocol_version: "1.7.0" };
  assert.ok(isServerReply(st));
  assert.deepEqual(parseServerReply(JSON.stringify(st)), st);
  // every field is in the schema
  for (const f of Object.keys(identity)) {
    assert.ok(f in manifest.messages.hello_result.properties, "hello_result." + f);
    assert.ok(f in manifest.messages.status_result.properties, "status_result." + f);
    assert.ok(!manifest.messages.hello_result.required.includes(f) && !manifest.messages.status_result.required.includes(f), f + " must stay optional");
  }
  assert.equal(SERVER_ID_PATTERN.source, manifest.messages.hello_result.properties.server_id.pattern);
  assert.equal(SERVER_ID_PATTERN.source, manifest.messages.status_result.properties.server_id.pattern);
});

test("server identity (1.7.0): a reply from an older server (no new fields) is still accepted", () => {
  // helloResult / statusReply above are the pre-1.7.0 shapes
  for (const k of Object.keys(identity)) assert.ok(!(k in helloResult) && !(k in statusReply), k);
  assert.ok(isServerReply(helloResult));
  assert.ok(isServerReply(statusReply));
  assert.deepEqual(parseServerReply(JSON.stringify(helloResult)), helloResult);
});

test("server identity (1.7.0): malformed identity fields are rejected", () => {
  for (const id of ["", "a b", "../x", "x".repeat(65), 1, null]) {
    assert.equal(isServerReply({ ...helloResult, server_id: id }), false, "hello " + String(id));
    assert.equal(isServerReply({ ...statusReply, server_id: id }), false, "status " + String(id));
  }
  for (const f of ["host", "user", "workspace", "server_version", "protocol_version"]) {
    assert.equal(isServerReply({ ...statusReply, [f]: 1 }), false, "status " + f);
  }
  for (const f of ["host", "user", "workspace"]) assert.equal(isServerReply({ ...helloResult, [f]: 1 }), false, "hello " + f);
});

// -- retire_server / retire_result (1.8.0) ---------------------------------------

const retireOk = {
  bantou: 1, type: "retire_result", ok: true, state: "retiring", stopped: { caps: 1, workers: 2 },
  exit_at: "2026-11-10T08:00:03.000Z", exit_code: 76,
  host_steps: ["sudo systemctl disable --now bantou-server.service && sudo rm /etc/systemd/system/bantou-server.service && sudo systemctl daemon-reload", "sudo userdel -r 'bantou'"],
};

test("retire_server: server_id と reason は省略可。形式の違うものと未知の型は拒否", () => {
  assert.ok(isRetireServerCommand({ bantou: 1, type: "retire_server" }));
  assert.ok(isRetireServerCommand({ bantou: 1, type: "retire_server", server_id: "srv-0a1b2c3d4e", reason: "lenovo の残り" }));
  assert.deepEqual(parseServerCommand(JSON.stringify({ bantou: 1, type: "retire_server" })), { bantou: 1, type: "retire_server" });
  for (const id of ["", "a b", "../x", "x".repeat(65), 1, null]) assert.equal(isServerCommand({ bantou: 1, type: "retire_server", server_id: id }), false, String(id));
  for (const r of [1, null, "a\0b"]) assert.equal(isServerCommand({ bantou: 1, type: "retire_server", reason: r }), false, String(r));
  assert.equal(isServerCommand({ bantou: 2, type: "retire_server" }), false);
  assert.equal(isServerCommand({ bantou: 1, type: "retire_servers" }), false);
  // 余計な field は許す（前方互換）
  assert.ok(isServerCommand({ bantou: 1, type: "retire_server", future: 1 }));
});

test("retire_result: 必須 field と 1..3 行の host_steps を検証。identity と service は省略可", () => {
  assert.ok(isServerReply(retireOk));
  assert.deepEqual(parseServerReply(JSON.stringify(retireOk)), retireOk);
  const full = { ...retireOk, server_id: "srv-1", host: "lenovo", user: "bantou", workspace: "/home/bantou", service: { manager: "systemd", name: "bantou-server.service", detected: true } };
  assert.ok(isServerReply(full));
  assert.ok(isServerReply({ ...retireOk, service: { manager: "none" } }));
  for (const bad of [
    { ok: false }, { state: "retired" }, { stopped: { caps: -1, workers: 0 } }, { stopped: { caps: 1.5, workers: 0 } }, { stopped: { caps: 1 } }, { stopped: null },
    { exit_at: 1 }, { exit_code: "76" }, { exit_code: 7.5 }, { host_steps: [] }, { host_steps: ["a", "b", "c", "d"] }, { host_steps: [""] }, { host_steps: [1] }, { host_steps: "x" },
    { service: { manager: "docker" } }, { service: { manager: "systemd", detected: "yes" } }, { server_id: "a b" },
  ]) assert.equal(isServerReply({ ...retireOk, ...bad }), false, JSON.stringify(bad));
  for (const k of ["stopped", "exit_at", "exit_code", "host_steps", "state"]) {
    const { [k]: _omit, ...rest } = retireOk;
    assert.equal(isServerReply(rest), false, k);
  }
});

test("error: command に retire_server、retiring:true を載せられる。旧形式（retiring 無し）も受理。retiring は true だけ", () => {
  assert.ok(isServerReply({ bantou: 1, type: "error", ok: false, message: "x", command: "retire_server" }));
  assert.ok(isServerReply({ bantou: 1, type: "error", ok: false, message: "退役中", command: "task", cap_id: "c1", task_id: "t1", retryable: false, retiring: true }));
  assert.equal(isServerReply({ bantou: 1, type: "error", ok: false, message: "x", retiring: false }), false);
  assert.equal(isServerReply({ bantou: 1, type: "error", ok: false, message: "x", retiring: "yes" }), false);
  assert.ok(isServerReply({ bantou: 1, type: "error", ok: false, message: "x" }));
});

test("retire: 1.8.0 未満の server には送らない（supportsRetire）。版が不明・不正は false", () => {
  assert.equal(RETIRE_MIN_PROTOCOL, "1.8.0");
  assert.equal(RETIRE_EXIT_CODE, 76);
  for (const v of ["1.8.0", "1.8.1", "1.9.0", "2.0.0", "1.10.0", "1.8.0-rc1"]) assert.equal(supportsRetire(v), true, v);
  for (const v of ["1.7.0", "1.7.9", "1.3.0", "0.9.0", "1.0.0"]) assert.equal(supportsRetire(v), false, v);
  for (const v of [undefined, "", "abc", "1.8", "v1.8.0"]) assert.equal(supportsRetire(v), false, String(v));
  assert.equal(supportsRetire(MESSENGER_PROTOCOL.version), true);
});

test("retire: manifest に retire_server / retire_result があり、error.command の enum と一致する", () => {
  assert.ok(manifest.messages.retire_server);
  assert.ok(manifest.messages.retire_result);
  assert.ok("retiring" in manifest.messages.error.properties);
  assert.deepEqual(manifest.messages.retire_result.required.slice().sort(), ["bantou", "type", "ok", "state", "stopped", "exit_at", "exit_code", "host_steps"].sort());
});

test("retire: 旧 server の hello_result / status_result など既存の返信形式は変わらず受理される", () => {
  assert.ok(isServerReply({ bantou: 1, type: "hello_result", ok: true, server_version: "0.6.2", protocol_version: "1.7.0", update: null, last_update: null }));
  assert.ok(isServerReply({ bantou: 1, type: "status_result", ok: true, caps: [], workers: [] }));
});

// -- stop_cap closes the cap (session_cleared) / status conversation: additive, no version bump ----------

test("stop_result: session_cleared / previous_session_id are optional (an older server sends neither); wrong types are rejected", () => {
  const base = { bantou: 1, type: "stop_result", ok: true, cap_id: "c1", stopped: true };
  assert.ok(isServerReply(base));
  assert.ok(isServerReply({ ...base, session_cleared: true, previous_session_id: "s-1" }));
  assert.ok(isServerReply({ ...base, stopped: false, session_cleared: false, previous_session_id: null }));
  assert.ok(!isServerReply({ ...base, session_cleared: "yes" }));
  assert.ok(!isServerReply({ ...base, previous_session_id: 1 }));
  assert.equal(MESSENGER_PROTOCOL.version, "1.8.1");
});

test("status_result: AgentStatus.conversation is optional and validated", () => {
  const agent = { kind: "cap", id: "c1", path: "/ws/caps/c1", session_id: null, state: "idle", last_started_at: null, last_finished_at: null, retries: 0, queued: 0 };
  const conversation = { started_at: "2026-11-11T00:00:00.000Z", tasks: 3, context_tokens: 112198, context_window: 1000000, context_percent: 11.2, usage_at: "2026-11-11T01:00:00.000Z", last_error_text: "Prompt is too long" };
  const st = (a) => ({ bantou: 1, type: "status_result", ok: true, caps: [a], workers: [] });
  assert.ok(isServerReply(st(agent)));
  assert.ok(isServerReply(st({ ...agent, conversation })));
  assert.ok(isServerReply(st({ ...agent, conversation: { ...conversation, context_tokens: null, context_window: null, context_percent: null, usage_at: null, last_error_text: undefined } })));
  assert.ok(!isServerReply(st({ ...agent, conversation: { ...conversation, tasks: -1 } })));
  assert.ok(!isServerReply(st({ ...agent, conversation: { ...conversation, context_tokens: "x" } })));
  assert.ok(!isServerReply(st({ ...agent, conversation: "x" })));
});

test("isProtocolCompatible: 同じ版・patch だけ違う版は互換", () => {
  assert.equal(isProtocolCompatible("1.8.1", "1.8.1"), true);
  assert.equal(isProtocolCompatible("1.8.0", "1.8.1"), true);
  assert.equal(isProtocolCompatible("1.8.12", "1.8.3"), true);
});

test("isProtocolCompatible: minor・major が違えば互換でない", () => {
  assert.equal(isProtocolCompatible("1.7.1", "1.8.1"), false);
  assert.equal(isProtocolCompatible("1.9.0", "1.8.1"), false);
  assert.equal(isProtocolCompatible("2.8.1", "1.8.1"), false);
  assert.equal(isProtocolCompatible("0.8.1", "1.8.1"), false);
});

test("isProtocolCompatible: 形が崩れた版は互換でない（どちらの引数でも）", () => {
  for (const bad of ["", "abc", "1.8", "1", "1.8.", "v1.8.1", "1.x.1", "1.8.1-beta", "1.8.1.2", " 1.8.1", undefined, null, 1.81]) {
    assert.equal(isProtocolCompatible(bad, "1.8.1"), false, String(bad));
    assert.equal(isProtocolCompatible("1.8.1", bad), false, String(bad));
  }
  assert.equal(isProtocolCompatible("", ""), false);
});

test("parallel tasks (additive): cap tasks on status_result / activity, task_id on a worker activity and on update runs", () => {
  const cap = { kind: "cap", id: "c-1", path: "/w/caps/c-1", session_id: null, state: "running", last_started_at: null, last_finished_at: null, retries: 0, queued: 1 };
  const t = (task_id, state, extra = {}) => ({ task_id, state, queued_at: "2026-11-21T00:00:00.000Z", started_at: null, finished_at: null, ...extra });
  const tasks = [t("t-1", "running", { branch: "feat/a", started_at: "2026-11-21T00:00:01.000Z" }), t("t-2", "waiting", { branch: "feat/a", waiting_for: "branch" }), t("t-3", "failed", { error: "x", finished_at: "2026-11-21T00:01:00.000Z" })];
  const st = (c) => ({ bantou: 1, type: "status_result", ok: true, caps: [c], workers: [] });
  assert.equal(isServerReply(st({ ...cap, tasks })), true);
  assert.equal(isServerReply(st({ ...cap, tasks: [] })), true);
  // 後の版で足された state / waiting_for の文字列も受ける
  assert.equal(isServerReply(st({ ...cap, tasks: [t("t-4", "paused", { waiting_for: "later" })] })), true);
  for (const bad of [{ tasks: "x" }, { tasks: [t("bad id", "running")] }, { tasks: [{ task_id: "t-1", state: "running" }] }, { tasks: [t("t-1", 1)] }]) {
    assert.equal(isServerReply(st({ ...cap, ...bad })), false, JSON.stringify(bad));
  }
  const capAgent = { ...activityAgent, kind: "cap", id: "r-1", cap_id: "r-1", tasks };
  const workerAgent = { ...activityAgent, task_id: "t-1" };
  assert.equal(isServerNotice({ ...activityNotice, agents: [capAgent, workerAgent] }), true);
  assert.equal(isServerNotice({ ...activityNotice, agents: [{ ...activityAgent, task_id: "bad id" }] }), false);
});

// -- change messages ------------------------------------------------------------
const registerChange = {
  bantou: 1, type: "register_change", change_id: "ch-1", scope: ["design", "tasks:1", "x"],
  repo: "https://example.com/r.git", notify_id: "n1",
};

test("register_change: scope は順序つきの参照の並びで、中身は解釈しない", () => {
  assert.equal(isServerCommand(registerChange), true);
  assert.equal(isRegisterChangeCommand(registerChange), true);
  assert.equal(isServerCommand({ ...registerChange, branch: "b", worker_model: "sonnet" }), true);
  assert.deepEqual(parseServerCommand(JSON.stringify(registerChange)).scope, ["design", "tasks:1", "x"]);
  assert.equal(isServerCommand({ ...registerChange, scope: [] }), false);
  assert.equal(isServerCommand({ ...registerChange, scope: ["a", ""] }), false);
  assert.equal(isServerCommand({ ...registerChange, scope: ["a", 1] }), false);
  assert.equal(isServerCommand({ ...registerChange, scope: "a" }), false);
  assert.equal(isServerCommand({ ...registerChange, change_id: "a b" }), false);
  assert.equal(isServerCommand({ ...registerChange, repo: "" }), false);
  assert.equal(isServerCommand({ ...registerChange, notify_id: undefined }), false);
  assert.equal(isServerCommand({ ...registerChange, worker_model: "bad model" }), false);
});

test("worker_reply / worker_stop は cap_id か change_id のどちらか 1 つを持つ", () => {
  const reply = { bantou: 1, type: "worker_reply", change_id: "ch-1", worker_id: "w1", text: "yes" };
  assert.equal(isWorkerReplyCommand(reply), true);
  assert.equal(isWorkerReplyCommand({ ...reply, change_id: undefined, cap_id: "c1" }), true);
  assert.equal(isServerCommand({ ...reply, cap_id: "c1" }), false, "両方は不可");
  assert.equal(isServerCommand({ ...reply, change_id: undefined }), false, "どちらも無いのは不可");
  assert.equal(isServerCommand({ ...reply, change_id: "a b" }), false);
  assert.equal(isServerCommand({ ...reply, text: "" }), false);
  assert.equal(isServerCommand({ ...reply, worker_id: "a b" }), false);
  const stop = { bantou: 1, type: "worker_stop", change_id: "ch-1", worker_id: "w1" };
  assert.equal(isServerCommand(stop), true);
  assert.equal(isServerCommand({ ...stop, change_id: undefined, cap_id: "c1", task_id: "t-1" }), true);
  assert.equal(isServerCommand({ ...stop, task_id: "t-1" }), false, "task_id は cap の worker だけ");
  assert.equal(isServerCommand({ ...stop, cap_id: "c1" }), false);
  assert.equal(isServerCommand({ ...stop, change_id: undefined }), false);
  assert.equal(isServerCommand({ ...stop, worker_id: undefined }), false);
  assert.equal(isServerCommand({ bantou: 1, type: "stop_change", change_id: "ch-1" }), false, "消した命令");
  assert.equal(isServerCommand({ bantou: 1, type: "change_status" }), false, "消した命令");
  assert.equal(isServerCommand({ bantou: 1, type: "change_reply", change_id: "ch-1", worker_id: "w1", text: "x" }), false, "消した命令");
});

test("今の cap 向けの command は変わらない", () => {
  assert.equal(isServerCommand({ bantou: 1, type: "worker_reply", cap_id: "c1", worker_id: "w1", text: "x" }), true);
  assert.equal(isServerCommand(stopCap), true);
});

test("change の reply", () => {
  assert.equal(isServerReply({ bantou: 1, type: "register_change_result", ok: true, change_id: "ch-1", accepted: true, state: "in_progress" }), true);
  assert.equal(isServerReply({ bantou: 1, type: "register_change_result", ok: true, change_id: "ch-1", accepted: true, state: "blocked" }), false);
  const rr = { bantou: 1, type: "worker_reply_result", ok: true, change_id: "ch-1", worker_id: "w1", accepted: true };
  assert.equal(isServerReply(rr), true);
  assert.equal(isServerReply({ ...rr, cap_id: "c1" }), false);
  assert.equal(isServerReply({ ...rr, change_id: undefined }), false);
  const sr = { bantou: 1, type: "worker_stop_result", ok: true, change_id: "ch-1", worker_id: "w1", stopped: true };
  assert.equal(isServerReply(sr), true);
  assert.equal(isServerReply({ ...sr, change_id: undefined, cap_id: "c1" }), true);
  assert.equal(isServerReply({ ...sr, stopped: "yes" }), false);
  assert.equal(isServerReply({ ...sr, worker_id: undefined }), false);
  assert.equal(isServerReply({ bantou: 1, type: "stop_change_result", ok: true, change_id: "ch-1", stopped: true }), false, "消した返信");
  assert.equal(isServerReply({ bantou: 1, type: "change_status_result", ok: true, changes: [] }), false, "消した返信");
});

test("error は change_id と change の command 名を持てる", () => {
  const err = { bantou: 1, type: "error", ok: false, message: "no", command: "register_change", change_id: "ch-1" };
  assert.equal(isServerReply({ ...err, command: "worker_stop" }), true);
  assert.equal(isServerReply(err), true);
  assert.equal(isServerReply({ ...err, change_id: "a b" }), false);
  assert.equal(isServerReply({ ...err, command: "nope" }), false);
});

test("change の通知: 質問（worker_report）/ 止められた・範囲を終えた（change_progress）", () => {
  const report = { bantou: 1, type: "worker_report", change_id: "ch-1", worker_id: "w1", kind: "ask", text: "which?", at: "2026-11-23T00:00:00.000Z" };
  assert.equal(isServerNotice(report), true);
  assert.equal(isServerNotice({ ...report, kind: "approve" }), true);
  assert.equal(isServerNotice({ ...report, cap_id: "c1" }), false, "cap_id と change_id の両方は不可");
  assert.equal(isServerNotice({ ...report, change_id: undefined }), false, "どちらも無いのは不可");
  assert.equal(isServerNotice({ ...report, task_id: "t-1" }), false, "change の report に task_id は付けない");
  assert.equal(isServerNotice({ ...report, change_id: "a b" }), false);
  assert.equal(isServerNotice({ ...report, change_id: undefined, cap_id: "c1", task_id: "t-1" }), true, "cap の worker_report は変わらない");
  assert.equal(isServerNotice({ bantou: 1, type: "change_report", notify_id: "n1", change_id: "ch-1", worker_id: "w1", step: 1, kind: "ask", text: "x", at: "t" }), false, "消した通知");
  const prog = {
    bantou: 1, type: "change_progress", notify_id: "n1", change_id: "ch-1", step: 2,
    change_state: "completed", step_state: "passed", at: "2026-11-23T00:00:00.000Z",
  };
  assert.equal(isServerNotice(prog), true);
  assert.equal(isServerNotice({ ...prog, change_state: "stopped", step_state: "stopped", reason: "user" }), true);
  assert.equal(isServerNotice({ ...prog, change_state: "blocked" }), false);
  assert.equal(isServerNotice({ ...prog, step_state: "x" }), false);
  assert.equal(parseServerNotice(JSON.stringify(prog)).change_state, "completed");
  // 今の通知は変わらない
  assert.equal(isServerNotice(activityNotice), true);
});
