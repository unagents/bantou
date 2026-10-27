import assert from "node:assert/strict";
import { test } from "node:test";
import { watchParent } from "../src/parent-watch.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("watchParent: ppid が変わったら 1 回だけ onOrphan を呼ぶ", async () => {
  let ppid = 100;
  const reasons: string[] = [];
  const stop = watchParent({ onOrphan: (r) => reasons.push(r), getPpid: () => ppid, intervalMs: 10 });
  try {
    await sleep(40);
    assert.equal(reasons.length, 0);
    ppid = 1;
    await sleep(60);
    assert.equal(reasons.length, 1);
    assert.match(reasons[0], /100 -> 1/);
  } finally {
    stop();
  }
});

test("watchParent: 停止後は ppid が変わっても呼ばない", async () => {
  let ppid = 100;
  let called = 0;
  const stop = watchParent({ onOrphan: () => called++, getPpid: () => ppid, intervalMs: 10 });
  stop();
  ppid = 1;
  await sleep(40);
  assert.equal(called, 0);
});
