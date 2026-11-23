import { test } from "node:test";
import assert from "node:assert/strict";
import type { ClaudeRunResult } from "../../../../server/utils/bantou/claude";
import { WORKER_SCHEMA, WORKER_SCHEMA_JSON, interpretResult } from "../../../../server/utils/bantou/result";

const ok = (structuredOutput: unknown, sessionId = "sess-1"): ClaudeRunResult => ({
  ok: true,
  sessionId,
  resultText: "",
  ...(structuredOutput !== undefined ? { structuredOutput } : {}),
  durationMs: 1,
});
const ng = (detail: string): ClaudeRunResult => ({ ok: false, sessionMissing: false, timedOut: false, detail, durationMs: 1 });

test("schema: lastType / status / content が全部必須で、それ以外は持てない", () => {
  assert.deepEqual([...WORKER_SCHEMA.required].sort(), ["content", "lastType", "status"]);
  assert.deepEqual(WORKER_SCHEMA.properties.lastType.enum, ["message", "report"]);
  assert.deepEqual(WORKER_SCHEMA.properties.status.enum, ["ask", "request_approve", "success", "failed"]);
  assert.equal(WORKER_SCHEMA.properties.content.type, "string");
  assert.equal(WORKER_SCHEMA.additionalProperties, false);
  assert.deepEqual(JSON.parse(WORKER_SCHEMA_JSON), JSON.parse(JSON.stringify(WORKER_SCHEMA)));
});

test("interpretResult: message（ask / request_approve）は session-id を最後の result から取って付ける", () => {
  assert.deepEqual(interpretResult(ok({ lastType: "message", status: "ask", content: "どちら？" }, "s-77")), {
    "session-id": "s-77",
    status: "ask",
    content: "どちら？",
  });
  assert.deepEqual(interpretResult(ok({ lastType: "message", status: "request_approve", content: "push してよい？" })), {
    "session-id": "sess-1",
    status: "request_approve",
    content: "push してよい？",
  });
});

test("interpretResult: report（success / failed）は session-id を付けない", () => {
  const s = interpretResult(ok({ lastType: "report", status: "success", content: "完了" }));
  assert.deepEqual(s, { status: "success", content: "完了" });
  assert.ok(!("session-id" in s));
  const f = interpretResult(ok({ lastType: "report", status: "failed", content: "失敗" }));
  assert.deepEqual(f, { status: "failed", content: "失敗" });
  assert.ok(!("session-id" in f));
});

test("interpretResult: process が落ちた（最後の出力が無い）時は failed を付ける", () => {
  const r = interpretResult(ng("終了コード 1"));
  assert.equal(r.status, "failed");
  assert.match(r.content, /終了コード 1/);
  assert.ok(!("session-id" in r));
  const t = interpretResult({ ok: false, sessionMissing: false, timedOut: true, detail: "タイムアウト (1000ms)", durationMs: 1 });
  assert.equal(t.status, "failed");
  assert.match(t.content, /タイムアウト/);
});

test("interpretResult: structured_output が無い・形が不正・組が不正なら failed", () => {
  for (const bad of [
    undefined,
    null,
    "text",
    [],
    { lastType: "message", status: "ask" },
    { lastType: "message", status: "ask", content: 1 },
    { lastType: "message", status: "success", content: "x" },
    { lastType: "report", status: "ask", content: "x" },
    { lastType: "report", status: "request_approve", content: "x" },
    { lastType: "other", status: "success", content: "x" },
    { status: "success", content: "x" },
  ]) {
    const r = interpretResult(ok(bad));
    assert.equal(r.status, "failed", JSON.stringify(bad));
    assert.ok(!("session-id" in r));
  }
});
