import { test } from "node:test";
import assert from "node:assert/strict";
import { capSessionName } from "../src/session-name.js";

test("capSessionName: <project>-cap。既に -cap で終わるなら足さない", () => {
  assert.equal(capSessionName("bantou"), "bantou-cap");
  assert.equal(capSessionName("pm1"), "pm1-cap");
  assert.equal(capSessionName("bantou-cap"), "bantou-cap");
  assert.equal(capSessionName("cap"), "cap-cap");
  assert.equal(capSessionName("my-cap-x"), "my-cap-x-cap");
});

test("parent-id（remote_id）は cap の名前 = capSessionName(session)。同じ cap の名前になる session 名は区別される（remotes の conflictsWith が拒否）", () => {
  assert.equal(capSessionName("bantou"), "bantou-cap");
  assert.equal(capSessionName("bantou"), capSessionName("bantou-cap"));
});
