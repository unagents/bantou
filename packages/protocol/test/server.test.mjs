import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  isServerCommand, isKickCapCommand, isStopCapCommand, isResumeWorkerCommand, isStatusCommand,
  parseServerCommand, isServerReply, parseServerReply,
  isActivityState, isServerNotice, parseServerNotice, ACTIVITY_STATES,
  isValidAgentId, isAgentState, SERVER_NAME, MESSENGER_PROTOCOL, AGENT_ID_PATTERN,
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
const stopResult = { bantou: 1, type: "stop_result", ok: true, cap_id: "c1", stopped: true };

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
  assert.deepEqual(Object.keys(manifest.messages).sort(), ["activity", "cap_result", "error", "kick_cap", "status", "status_result", "stop_cap", "stop_result"]);
  for (const [k, schema] of Object.entries(manifest.messages)) {
    assert.equal(schema.type, "object", k);
    assert.equal(schema.properties.type.const, k, k);
    assert.equal(schema.properties.bantou.const, 1, k);
  }
});

test("protocol.json required fields agree with the guards", () => {
  const m = manifest.messages;
  // every sample accepted by the guards carries all required fields of its schema
  const samples = { activity: activityNotice, kick_cap: kickMin, stop_cap: stopCap, stop_result: stopResult, status, cap_result: capResult, status_result: statusReply, error: errReply };
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
  assert.deepEqual(manifest.messages.error.properties.command.enum, ["kick_cap", "resume_worker", "stop_cap", "status"]);
  assert.equal(MESSENGER_PROTOCOL.version, "1.2.0");
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
