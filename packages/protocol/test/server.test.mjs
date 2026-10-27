import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isServerCommand, isLaunchSessionCommand, isListSessionsCommand, parseServerCommand,
  isServerReply, parseServerReply, isValidSessionName, SERVER_NAME,
} from "../dist/index.js";

const launchMin = { bantou: 1, type: "launch_session", name: "s1" };
const launchFull = {
  bantou: 1, type: "launch_session", name: "my-sess_2",
  repo: "git@github.com:unagents/bantou.git", branch: "develop", cwd: "bantou",
};
const list = { bantou: 1, type: "list_sessions" };

test("server name", () => {
  assert.equal(SERVER_NAME, "bantou-server");
});

test("isServerCommand accepts valid commands", () => {
  assert.ok(isServerCommand(launchMin) && isLaunchSessionCommand(launchMin) && !isListSessionsCommand(launchMin));
  assert.ok(isServerCommand(launchFull) && isLaunchSessionCommand(launchFull));
  assert.ok(isServerCommand(list) && isListSessionsCommand(list) && !isLaunchSessionCommand(list));
});

test("isServerCommand rejects invalid input", () => {
  assert.equal(isServerCommand(null), false);
  assert.equal(isServerCommand([]), false);
  assert.equal(isServerCommand({ ...launchMin, bantou: 2 }), false);
  assert.equal(isServerCommand({ ...list, bantou: 2 }), false);
  assert.equal(isServerCommand({ bantou: 1, type: "kill_session", name: "a" }), false);
  assert.equal(isServerCommand({ bantou: 1, type: "launch_session" }), false);
  for (const name of ["a b", "a.b", "a:b", "", "../x"]) {
    assert.equal(isServerCommand({ ...launchMin, name }), false, `name=${JSON.stringify(name)}`);
  }
  assert.equal(isServerCommand({ ...launchMin, repo: "" }), false);
  assert.equal(isServerCommand({ ...launchMin, branch: "" }), false);
  assert.equal(isServerCommand({ ...launchMin, cwd: "" }), false);
  assert.equal(isServerCommand({ ...launchMin, repo: 1 }), false);
  for (const k of ["repo", "branch", "cwd"]) {
    assert.equal(isServerCommand({ ...launchMin, [k]: "--upload-pack=x" }), false);
    assert.equal(isServerCommand({ ...launchMin, [k]: "-x" }), false);
    assert.equal(isServerCommand({ ...launchMin, [k]: "a\0b" }), false);
  }
});

test("parseServerCommand", () => {
  assert.equal(parseServerCommand("hello"), undefined);
  assert.equal(parseServerCommand('{"a":1}'), undefined);
  assert.equal(
    parseServerCommand(JSON.stringify({ bantou: 1, type: "task", task_id: "t1", title: "x" })),
    undefined,
  );
  assert.deepEqual(parseServerCommand(` ${JSON.stringify(launchFull)}\n`), launchFull);
  assert.deepEqual(parseServerCommand(JSON.stringify(list)), list);
});

const launched = { bantou: 1, type: "session_launched", ok: true, name: "s1", tmux: "s1", cwd: "/w/repos/s1" };
const sessions = {
  bantou: 1, type: "sessions", ok: true,
  sessions: [{ name: "s1", windows: 1, created: "2026-10-27T10:00:00Z", attached: false }],
};
const errReply = { bantou: 1, type: "error", ok: false, message: "boom", command: "launch_session" };

test("isServerReply accepts the three reply shapes", () => {
  assert.ok(isServerReply(launched));
  assert.ok(isServerReply(sessions));
  assert.ok(isServerReply({ ...sessions, sessions: [] }));
  assert.ok(isServerReply(errReply));
  assert.ok(isServerReply({ bantou: 1, type: "error", ok: false, message: "boom" }));
});

test("isServerReply rejects mismatches", () => {
  assert.equal(isServerReply({ ...launched, ok: false }), false);
  assert.equal(isServerReply({ ...sessions, ok: false }), false);
  assert.equal(isServerReply({ ...errReply, ok: true }), false);
  assert.equal(isServerReply({ ...launched, bantou: 2 }), false);
  assert.equal(isServerReply({ ...launched, tmux: undefined }), false);
  assert.equal(isServerReply({ ...errReply, command: "nope" }), false);
  assert.equal(isServerReply({ ...errReply, message: 1 }), false);
  assert.equal(isServerReply({ bantou: 1, type: "other", ok: true }), false);
  assert.equal(isServerReply({ ...sessions, sessions: [{ name: "s1", windows: "1", created: "x", attached: false }] }), false);
  assert.equal(isServerReply({ ...sessions, sessions: [{ name: "s1", windows: 1, created: "x" }] }), false);
  assert.equal(isServerReply({ ...sessions, sessions: [null] }), false);
  assert.equal(isServerReply({ ...sessions, sessions: "x" }), false);
});

test("parseServerReply", () => {
  assert.equal(parseServerReply("hello"), undefined);
  assert.equal(parseServerReply('{"a":1}'), undefined);
  assert.deepEqual(parseServerReply(`${JSON.stringify(sessions)}\n`), sessions);
});

test("isValidSessionName", () => {
  assert.ok(isValidSessionName("abc-DEF_09"));
  for (const n of ["", "a b", "a.b", "a:b", "../x", 1, null, undefined]) {
    assert.equal(isValidSessionName(n), false);
  }
});
