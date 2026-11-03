import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  isServerCommand, isKickCapCommand, isStopCapCommand, isResumeWorkerCommand, isStatusCommand,
  parseServerCommand, isServerReply, parseServerReply,
  isActivityState, isServerNotice, parseServerNotice, ACTIVITY_STATES,
  isValidAgentId, isAgentState, SERVER_NAME, MESSENGER_PROTOCOL, AGENT_ID_PATTERN,
  isHelloCommand, isUpdateServerCommand, isValidServerVersion, isErrorCode, ERROR_CODES,
  FOLLOW_MIN_PROTOCOL, SERVER_VERSION_PATTERN, MODEL_PATTERN, isValidModel,
  isTaskCommand, isWorkerReplyCommand, isWorkerRole, isWorkerReportKind,
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
  assert.deepEqual(Object.keys(manifest.messages).sort(), ["activity", "cap_result", "error", "hello", "hello_result", "kick_cap", "status", "status_result", "stop_cap", "stop_result", "task", "task_result", "update_result", "update_server", "worker_reply", "worker_reply_result", "worker_report"]);
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
  assert.deepEqual(manifest.messages.error.properties.command.enum, ["kick_cap", "resume_worker", "stop_cap", "status", "hello", "update_server", "task", "worker_reply"]);
  assert.equal(MESSENGER_PROTOCOL.version, "1.5.0");
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

test("protocol version 1.5.0 (task / worker_reply / worker_report)", () => {
  assert.equal(MESSENGER_PROTOCOL.version, "1.5.0");
  assert.equal(manifest.version, "1.5.0");
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
