import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isServerCommand, isKickCapCommand, isResumeWorkerCommand, isStatusCommand,
  parseServerCommand, isServerReply, parseServerReply,
  isValidAgentId, isAgentState, SERVER_NAME,
} from "../dist/index.js";

const kickMin = { bantou: 1, type: "kick_cap", cap_id: "c1", prompt: "go" };
const kickFull = {
  bantou: 1, type: "kick_cap", cap_id: "my-cap_2", prompt: "do it",
  repo: "git@github.com:unagents/bantou.git", branch: "develop", reason: "nightly",
};
const resumeMin = { bantou: 1, type: "resume_worker", worker_id: "w1", prompt: "continue" };
const resumeRepo = { ...resumeMin, repo: "https://example.com/r.git", branch: "main" };
const status = { bantou: 1, type: "status" };

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
