import { test } from "node:test";
import assert from "node:assert/strict";
import {
  workspaceKey, sessionsPath, threadPath, inboxPath,
  formatReply, pingSubject,
} from "../dist/index.js";

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
