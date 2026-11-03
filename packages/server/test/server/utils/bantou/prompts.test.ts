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

test("prompts: cap の決まり（自分で実装しない・2 体・往復上限・並列・指示の中身・最終返答）を含む", () => {
  for (const k of [
    "自分では実装しない",
    "作業は必ず worker にさせる",
    "実装 worker と review worker",
    "別 clone",
    "同じ worker_id で worker_start",
    "最大 3 回",
    "別 worker で並列",
    "成果物: branch、commit、report の置き場",
    "確認方法: どのテストを回すか",
    "repo 引数を使わない",
    "GIT_CONFIG_GLOBAL",
    "version bump しない",
    "worker_model",
    "review worker は実装と同じか軽いもの",
    "review の結論、残った問題",
  ]) assert.ok(CAP_GUIDE.includes(k), k);
});
