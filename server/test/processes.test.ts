import { test } from "node:test";
import assert from "node:assert/strict";
import { matchesSession, parsePsOutput } from "../src/processes.js";

test("processes: parsePsOutput は pid と argv に分ける", () => {
  const out = "    1 /sbin/init splash\n 4242 claude -p --resume abc -- hi there\n\nbad line\n";
  assert.deepEqual(parsePsOutput(out), [
    { pid: 1, argv: "/sbin/init splash" },
    { pid: 4242, argv: "claude -p --resume abc -- hi there" },
  ]);
});

test("processes: matchesSession は --session-id / --resume の session だけ一致", () => {
  const sid = "11111111-2222-3333-4444-555555555555";
  assert.ok(matchesSession(`claude -p --session-id ${sid} -- x`, sid));
  assert.ok(matchesSession(`claude -p --resume ${sid} -- x`, sid));
  assert.ok(matchesSession(`claude --print --resume ${sid}`, sid));
  assert.ok(!matchesSession(`claude -p --resume other -- x`, sid));
  assert.ok(!matchesSession(`claude -p -- ${sid}`, sid));
});

test("processes: matchesSession は prompt 内の id・前方一致・-p 無しを除外", () => {
  const sid = "11111111-2222-3333-4444-555555555555";
  // prompt（" -- " の後ろ）に id が含まれる
  assert.ok(!matchesSession(`claude -p --permission-mode auto --session-id other -- note --resume ${sid} here`, sid));
  // 長い id の前方一致
  assert.ok(!matchesSession(`claude -p --resume ${sid}-extra -- x`, sid));
  assert.ok(!matchesSession(`claude -p --resume ${sid}0 -- x`, sid));
  // -p / --print 無し
  assert.ok(!matchesSession(`claude --resume ${sid}`, sid));
  assert.ok(!matchesSession(`vim --resume ${sid} -- x`, sid));
  // 他オプションが前後にある通常形
  assert.ok(matchesSession(`claude -p --output-format stream-json --verbose --permission-mode auto --session-id ${sid} -- hello world`, sid));
});
