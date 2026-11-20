import { test } from "node:test";
import assert from "node:assert/strict";
import { capSessionName } from "../src/session-name.js";
import { sessionCapId } from "../src/center-id.js";

test("capSessionName: <project>-cap。既に -cap で終わるなら足さない", () => {
  assert.equal(capSessionName("bantou"), "bantou-cap");
  assert.equal(capSessionName("pm1"), "pm1-cap");
  assert.equal(capSessionName("bantou-cap"), "bantou-cap");
  assert.equal(capSessionName("cap"), "cap-cap");
  assert.equal(capSessionName("my-cap-x"), "my-cap-x-cap");
});

test("内部の識別子は変えない: cap_id は project 名のまま（-cap を含まない）", () => {
  assert.equal(sessionCapId("c-0123456789", "bantou"), "c-0123456789-bantou");
  assert.notEqual(sessionCapId("c-0123456789", "bantou"), sessionCapId("c-0123456789", capSessionName("bantou")));
});
