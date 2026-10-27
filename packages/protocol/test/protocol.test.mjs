import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isEnvelope, isTaskMessage, isAskMessage, parseEnvelope,
  workspaceKey, sessionsPath, threadPath, inboxPath,
  formatReply, pingSubject,
} from "../dist/index.js";

const task = { bantou: 1, type: "task", task_id: "t-cr001", title: "xlsx 取込の列マッピング", status: "Doing" };
const ask = {
  bantou: 1, type: "ask", task_id: "t-cr001", title: "x", question: "q",
  options: [{ label: "a", description: "b" }, { label: "c" }],
};

test("guards accept doc examples", () => {
  assert.ok(isEnvelope(task) && isTaskMessage(task) && !isAskMessage(task));
  assert.ok(isEnvelope(ask) && isAskMessage(ask) && !isTaskMessage(ask));
  assert.ok(isAskMessage({ bantou: 1, type: "ask", task_id: "a", question: "q" }));
});

test("guards reject invalid input", () => {
  assert.equal(isEnvelope(null), false);
  assert.equal(isEnvelope([]), false);
  assert.equal(isEnvelope({ ...task, bantou: 2 }), false);
  assert.equal(isEnvelope({ ...task, type: "ping" }), false);
  assert.equal(isEnvelope({ ...task, task_id: "a b" }), false);
  assert.equal(isEnvelope({ ...task, task_id: "" }), false);
  assert.equal(isEnvelope({ bantou: 1, type: "task", task_id: "a" }), false);
  assert.equal(isEnvelope({ ...ask, question: undefined }), false);
  assert.equal(isEnvelope({ ...ask, options: [{ description: "x" }] }), false);
});

test("parseEnvelope returns undefined for non-JSON / non-envelope", () => {
  assert.equal(parseEnvelope("hello"), undefined);
  assert.equal(parseEnvelope('{"a":1}'), undefined);
  assert.deepEqual(parseEnvelope(` ${JSON.stringify(task)}\n`), task);
});

test("workspaceKey replaces / with -", () => {
  assert.equal(workspaceKey("/Users/koube/work/x"), "-Users-koube-work-x");
  assert.equal(
    sessionsPath("/home/u", "/a/b"),
    "/home/u/.local/share/bantou/-a-b/sessions.json",
  );
  assert.equal(threadPath("/home/u", "/a/b", "t1"), "/home/u/.local/share/bantou/-a-b/threads/t1.json");
  assert.equal(inboxPath("/home/u", "/a/b"), "/home/u/.local/share/bantou/-a-b/inbox.jsonl");
});

test("reply text and ping subject", () => {
  assert.equal(formatReply("A", "B"), "【ユーザー回答（原文）】\nA\n\n【bantou 指示】\nB");
  assert.equal(pingSubject({ text: " t1 ", subject: "s" }), "t1");
  assert.equal(pingSubject({ text: " ", subject: "s" }), "s");
  assert.equal(pingSubject({}), undefined);
});
