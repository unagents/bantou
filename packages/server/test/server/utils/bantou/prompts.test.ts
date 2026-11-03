import { test } from "node:test";
import assert from "node:assert/strict";
import { CAP_GUIDE, WORKER_GUIDE } from "../../../../server/utils/bantou/prompts";

test("prompts: 本文に ' -- ' を含めない", () => {
  for (const g of [CAP_GUIDE, WORKER_GUIDE]) {
    assert.equal(g.includes(" -- "), false);
    assert.ok(g.length > 0);
  }
});

test("prompts: cap は worker tool を、worker は report を案内する", () => {
  for (const t of ["mcp__bantou__worker_start", "mcp__bantou__worker_status", "mcp__bantou__worker_stop"]) assert.ok(CAP_GUIDE.includes(t), t);
  assert.ok(CAP_GUIDE.includes("claude を直接起動しない"));
  assert.ok(WORKER_GUIDE.includes("mcp__bantou__report"));
});
