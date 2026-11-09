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

import { buildTaskPrompt, buildTaskResult, extractTaskResult } from "../../../../server/utils/bantou/prompts";
import type { TaskCommand } from "@agent-hand/bantou-protocol";

const task: TaskCommand = {
  bantou: 1,
  type: "task",
  cap_id: "c1",
  task_id: "t-1",
  goal: "task メッセージを足す",
  repo: "https://github.com/unagents/bantou.git",
  branch: "feature/protocol-task",
  deliverables: { branch: "feature/x", report_path: "docs/history/x/report.md", other: ["PR 説明"] },
  verify: { tests: ["npm test"], steps: ["差分を読む"] },
  constraints: ["version bump しない"],
  workers: { items: [{ id: "impl", role: "implement", scope: "server", model: "sonnet" }, { role: "review", scope: "差分", depends_on: ["impl"] }] },
  worker_model: "haiku",
};

test("task 指示: goal・base・成果物・確認方法・制約・分担・model を定型で組み立てる", () => {
  const p = buildTaskPrompt(task);
  assert.ok(p.startsWith("[task t-1]\n"));
  for (const k of [
    "[目的]\ntask メッセージを足す",
    "repo: https://github.com/unagents/bantou.git",
    "branch: feature/protocol-task",
    "- push 先 branch: feature/x",
    "- report の置き場: docs/history/x/report.md",
    "- PR 説明",
    "- 回すテスト: npm test",
    "- 手順: 差分を読む",
    "[制約]\n- version bump しない",
    "- impl: role=implement scope=server model=sonnet",
    "- #2: role=review scope=差分 depends_on=impl",
    "worker_model: haiku",
    "task_result の JSON",
  ]) assert.ok(p.includes(k), k);
  assert.ok(!p.includes("最低 2 体"));
  assert.equal(p.includes(" -- "), false);
});

test("task 指示: 最小形は既定の分担（最低 2 体）で、指定なしを明記する", () => {
  const p = buildTaskPrompt({ ...task, repo: undefined, branch: undefined, deliverables: {}, verify: {}, constraints: [], workers: {}, worker_model: undefined });
  assert.ok(p.includes("最低 2 体: 実装 worker と review worker"));
  assert.ok(!p.includes("[作業の base]"));
  assert.ok(!p.includes("[worker の model]"));
  assert.ok(p.includes("[成果物]\n- 指定なし"));
  assert.ok(p.includes("[確認方法]\n- 指定なし"));
  assert.ok(p.includes("[制約]\n- なし"));
});

test("task 指示: items に実装か review が無ければ cap が足す旨を書く", () => {
  const p = buildTaskPrompt({ ...task, workers: { items: [{ role: "docs", scope: "docs" }] } });
  assert.ok(p.includes("足りない方の worker を cap が追加する"));
});

test("CAP_GUIDE: worker への指示に、終わったら clone と生成物を自分で消す後始末を含める", () => {
  assert.ok(CAP_GUIDE.includes("後始末: 終わったら"));
  assert.ok(CAP_GUIDE.includes("自分の clone・node_modules・ビルド生成物"));
  assert.ok(CAP_GUIDE.includes("logs/ と state.json は消さない"));
});

test("CAP_GUIDE: task_result の JSON で返す・report 無しで idle の worker を再開させる", () => {
  for (const k of ["task_result の JSON 1 つで返す", "```json", '"verdict"', "report を送らずに idle", "同じ worker_id で worker_start して report を送るよう指示"]) {
    assert.ok(CAP_GUIDE.includes(k), k);
  }
});

const body = {
  state: "done",
  summary: "実装して review も通った",
  workers: [{ worker_id: "w-1", role: "implement", state: "done", branch: "b", commit: "abc", tests: "41 pass", report_path: "r.md", result: "x".repeat(600) }],
  review: { verdict: "issues", items: [{ severity: "high", text: "穴", resolved: true }], rounds: 2 },
  remaining: ["docs"],
};

test("task_result の取り出し: ```json ブロック（前後に説明あり）", () => {
  const r = extractTaskResult("c1", "t-1", `結果です。\n\`\`\`json\n${JSON.stringify(body)}\n\`\`\`\n以上。`);
  assert.ok(r);
  assert.equal(r.type, "task_result");
  assert.equal(r.cap_id, "c1");
  assert.equal(r.task_id, "t-1");
  assert.equal(r.state, "done");
  assert.equal(r.summary, body.summary);
  assert.equal(r.workers[0]!.worker_id, "w-1");
  assert.equal(r.workers[0]!.result.length, 500);
  assert.equal(r.workers[0]!.commit, "abc");
  assert.deepEqual(r.review, body.review);
  assert.deepEqual(r.remaining, ["docs"]);
});

test("task_result の取り出し: 裸の JSON、複数ブロックは最後を採る、summary 無しの JSON は採らない", () => {
  assert.equal(extractTaskResult("c1", "t-1", `前置き ${JSON.stringify(body)}`)?.summary, body.summary);
  const two = `\`\`\`json\n${JSON.stringify({ ...body, summary: "古い" })}\n\`\`\`\n\`\`\`json\n${JSON.stringify({ ...body, summary: "新しい" })}\n\`\`\``;
  assert.equal(extractTaskResult("c1", "t-1", two)?.summary, "新しい");
  assert.equal(extractTaskResult("c1", "t-1", '```json\n{"foo":1}\n```'), undefined);
  assert.equal(extractTaskResult("c1", "t-1", "ただの文章"), undefined);
  assert.equal(extractTaskResult("c1", "t-1", "{壊れた"), undefined);
  // 文字列中の } で切れない
  assert.equal(extractTaskResult("c1", "t-1", '{"summary":"a } b"}')?.summary, "a } b");
});

test("task_result の取り出し: 崩れた項目は既定値で補い、使えない項目は落とす", () => {
  const r = extractTaskResult("c1", "t-1", JSON.stringify({
    state: "weird",
    summary: "s",
    workers: [{ worker_id: "w 1", role: "implement" }, { worker_id: "w-2", role: "boss", state: "x" }, "x"],
    review: { verdict: "maybe", items: [{ severity: "fatal", text: "t" }, { text: 1 }], rounds: -1 },
    remaining: ["a", 1],
  }));
  assert.ok(r);
  assert.equal(r.state, "done");
  assert.deepEqual(r.workers, [{ worker_id: "w-2", role: "other", state: "idle", result: "" }]);
  assert.deepEqual(r.review, { verdict: "unknown", items: [{ severity: "medium", text: "t", resolved: false }], rounds: 0 });
  assert.deepEqual(r.remaining, ["a"]);
  assert.equal(extractTaskResult("c1", "t-1", '{"summary":"s","state":"failed","error":"e"}')?.state, "failed");
});

test("task_result: 取り出せなければ summary に生の返答、review.verdict は unknown。失敗は failed + error", () => {
  const raw = buildTaskResult("c1", "t-1", { session_id: "s", ok: true, result_text: "worker を起動した" });
  assert.deepEqual(raw, {
    bantou: 1, type: "task_result", cap_id: "c1", task_id: "t-1", state: "done", summary: "worker を起動した",
    workers: [], review: { verdict: "unknown", items: [], rounds: 0 }, remaining: [],
  });
  const ok = buildTaskResult("c1", "t-1", { session_id: "s", ok: true, result_text: JSON.stringify(body) });
  assert.equal(ok.summary, body.summary);
  const ng = buildTaskResult("c1", "t-1", { session_id: "s", ok: false, result_text: "", error: "exit 1" });
  assert.equal(ng.state, "failed");
  assert.equal(ng.error, "exit 1");
  assert.equal(ng.review.verdict, "unknown");
});

test("prompts: worker の system prompt に常設の制約（server / center を install・起動・停止・再起動しない）を含む", () => {
  assert.ok(WORKER_GUIDE.includes("[常設の制約]"));
  assert.ok(WORKER_GUIDE.includes("bantou-server / bantou-center を install・起動・停止・再起動しない"));
  assert.ok(WORKER_GUIDE.includes("report で報告するだけ"));
});
