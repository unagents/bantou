import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { COMMON_MD, WORKER_MD } from "../../../../server/utils/bantou/instructions.generated";
import {
  APPROVE_PROMPT,
  COMMON_TEXT,
  EMPTY_ANSWER_PROMPT,
  REJECT_PROMPT,
  WORKER_GUIDE,
  WORKER_TEXT,
  replyPrompt,
} from "../../../../server/utils/bantou/prompts";

const read = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

test("prompts: 本文に ' -- ' を含めない", () => {
  assert.equal(WORKER_GUIDE.includes(" -- "), false);
  assert.ok(WORKER_GUIDE.length > 0);
});

test("prompts: worker は report 道具ではなく最後の返答の JSON（lastType / status / content）を案内する", () => {
  assert.equal(WORKER_GUIDE.includes("mcp__bantou__report"), false);
  for (const k of ["lastType", "status", "content", "message", "report", "ask", "request_approve", "success", "failed", "mcp__bantou__bash"]) {
    assert.ok(WORKER_GUIDE.includes(k), k);
  }
  assert.ok(WORKER_GUIDE.includes(COMMON_TEXT));
  assert.ok(WORKER_GUIDE.includes(WORKER_TEXT));
});

test("prompts: 生成物 instructions.generated.ts は md と一致する（gen-instructions.mjs を回し忘れない）", () => {
  assert.equal(COMMON_MD, read("../../../../../center/instructions/common.md"));
  assert.equal(WORKER_MD, read("../../../../instructions/worker.md"));
});

test("replyPrompt: answer は content をそのまま、approve / reject は固定の短い文", () => {
  assert.equal(replyPrompt("answer", "A案で行く"), "A案で行く");
  assert.equal(replyPrompt("answer", ""), EMPTY_ANSWER_PROMPT);
  assert.equal(replyPrompt("answer", "   "), EMPTY_ANSWER_PROMPT);
  assert.equal(replyPrompt("answer"), EMPTY_ANSWER_PROMPT);
  assert.equal(replyPrompt("approve"), APPROVE_PROMPT);
  assert.equal(replyPrompt("reject"), REJECT_PROMPT);
  assert.notEqual(APPROVE_PROMPT, REJECT_PROMPT);
  for (const p of [APPROVE_PROMPT, REJECT_PROMPT, EMPTY_ANSWER_PROMPT]) assert.ok(p.length > 0 && p.length < 80);
});
