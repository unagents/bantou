import { test } from "node:test";
import assert from "node:assert/strict";
import { authenticate, safeEqual } from "../server/utils/auth.ts";

const h = (o: Record<string, string>) => (n: string) => o[n];

test("token と X-Agent-Id が揃えば通る", () => {
  const r = authenticate("s3cret", h({ authorization: "Bearer s3cret", "x-agent-id": "pm-a" }));
  assert.deepEqual(r, { ok: true, agentId: "pm-a" });
});
test("token 無しは 401 相当", () => {
  assert.equal(authenticate("s3cret", h({ "x-agent-id": "a" })).ok, false);
});
test("不正 token は拒否", () => {
  const r = authenticate("s3cret", h({ authorization: "Bearer nope", "x-agent-id": "a" }));
  assert.deepEqual(r, { ok: false, reason: "bad-token" });
});
test("X-Agent-Id 無しは拒否", () => {
  const r = authenticate("s3cret", h({ authorization: "Bearer s3cret" }));
  assert.deepEqual(r, { ok: false, reason: "missing-agent-id" });
});
test("token 未設定の server は常に拒否", () => {
  assert.equal(authenticate("", h({ authorization: "Bearer ", "x-agent-id": "a" })).ok, false);
});
test("safeEqual: 長さ違いも false", () => {
  assert.equal(safeEqual("a", "ab"), false);
  assert.equal(safeEqual("abc", "abc"), true);
});
