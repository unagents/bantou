import { test } from "node:test";
import assert from "node:assert/strict";
import { agentDir, runLogDir, stateFile } from "../../../../server/utils/bantou/paths";

test("paths: agentDir は cap / worker の配下", () => {
  assert.equal(agentDir("/ws", "cap", "c-1"), "/ws/caps/c-1");
  assert.equal(agentDir("/ws", "worker", "w_1"), "/ws/workers/w_1");
  assert.equal(stateFile("/ws/caps/c-1"), "/ws/caps/c-1/state.json");
  assert.equal(runLogDir("/ws/caps/c-1"), "/ws/caps/c-1/logs");
});

for (const id of ["../x", "a b", "", "a/b", ".."]) {
  test(`paths: 不正な id ${JSON.stringify(id)} は拒否`, () => {
    assert.throws(() => agentDir("/ws", "cap", id), /cap_id が不正/);
    assert.throws(() => agentDir("/ws", "worker", id), /worker_id が不正/);
  });
}
