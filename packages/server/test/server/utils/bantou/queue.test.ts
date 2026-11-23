import { test } from "node:test";
import assert from "node:assert/strict";
import { createWorkQueue, type Job } from "../../../../server/utils/bantou/queue";

/** 手で終わらせられる job。 */
function makeJob(kind: "launch" | "reply", parentId: string, name: string, events: string[], sessionId: string = name): Job & { finish(): void; aborted: boolean; cancelledCalled: boolean } {
  let done!: () => void;
  const p = new Promise<void>((r) => (done = r));
  const job = {
    kind,
    parentId,
    sessionId,
    aborted: false,
    cancelledCalled: false,
    start: () => {
      events.push(`start:${name}`);
      return p;
    },
    abort() {
      job.aborted = true;
      done();
    },
    cancelled() {
      job.cancelledCalled = true;
    },
    finish: () => done(),
  };
  return job;
}

const tick = (): Promise<void> => new Promise((r) => setImmediate(r));

const opts = (over: Partial<Parameters<typeof createWorkQueue>[0]> = {}) => ({
  maxParallel: 2,
  cpus: () => 4,
  loadavg1: () => 0,
  pollMs: 10,
  ...over,
});

test("queue: 空きが在ればすぐ起こし、上限を超えた分は来た順に待ち、終わるたびに先頭を 1 本起こす", async () => {
  const ev: string[] = [];
  const q = createWorkQueue(opts());
  const [a, b, c, d] = ["a", "b", "c", "d"].map((n) => makeJob("launch", "cap", n, ev));
  for (const j of [a, b, c, d]) q.submit(j!);
  assert.deepEqual(ev, ["start:a", "start:b"]);
  assert.deepEqual(q.counts(), { running: 2, queued: 2 });
  a!.finish();
  await tick();
  assert.deepEqual(ev, ["start:a", "start:b", "start:c"]);
  b!.finish();
  await tick();
  assert.deepEqual(ev, ["start:a", "start:b", "start:c", "start:d"]);
  c!.finish();
  d!.finish();
  await tick();
  assert.deepEqual(q.counts(), { running: 0, queued: 0 });
  q.close();
});

test("queue: reply は queue で新しい launch より先（reply 同士は来た順）。数は上限に数える", async () => {
  const ev: string[] = [];
  const q = createWorkQueue(opts({ maxParallel: 1 }));
  const l1 = makeJob("launch", "cap", "l1", ev);
  const l2 = makeJob("launch", "cap", "l2", ev);
  const r1 = makeJob("reply", "cap", "r1", ev);
  const r2 = makeJob("reply", "cap", "r2", ev);
  q.submit(l1);
  q.submit(l2);
  q.submit(r1);
  q.submit(r2);
  assert.deepEqual(ev, ["start:l1"]);
  l1.finish();
  await tick();
  assert.deepEqual(ev, ["start:l1", "start:r1"]);
  r1.finish();
  await tick();
  r2.finish();
  await tick();
  l2.finish();
  await tick();
  assert.deepEqual(ev, ["start:l1", "start:r1", "start:r2", "start:l2"]);
  q.close();
});

test("queue: 動いている session への reply は、その run の終了後に起動する（空きが在っても待ち、終われば launch より先）", async () => {
  const ev: string[] = [];
  const q = createWorkQueue(opts({ maxParallel: 3 }));
  const run = makeJob("launch", "cap", "run", ev, "sess-1");
  const reply = makeJob("reply", "cap", "reply", ev, "sess-1");
  const other = makeJob("launch", "cap", "other", ev, "sess-2");
  q.submit(run);
  q.submit(reply);
  assert.deepEqual(ev, ["start:run"], "空きが在っても、同じ session の run が終わるまで reply は起こさない");
  assert.deepEqual(q.counts(), { running: 1, queued: 1 });
  q.submit(other);
  assert.deepEqual(ev, ["start:run", "start:other"], "別の session の launch は待たされない");
  run.finish();
  await tick();
  assert.deepEqual(ev, ["start:run", "start:other", "start:reply"]);
  reply.finish();
  other.finish();
  await tick();
  q.close();
});

test("queue: 負荷平均が CPU 数を超えている間は、空きが在っても起こさない。下がれば timer で起こす（同じ値は超えていない）", async () => {
  const ev: string[] = [];
  let load = 5;
  const q = createWorkQueue(opts({ loadavg1: () => load, cpus: () => 4 }));
  const a = makeJob("launch", "cap", "a", ev);
  q.submit(a);
  assert.deepEqual(ev, []);
  assert.deepEqual(q.counts(), { running: 0, queued: 1 });
  await new Promise((r) => setTimeout(r, 40));
  assert.deepEqual(ev, [], "高負荷の間は起こさない");
  load = 4; // 等しいだけなら超えていない
  await new Promise((r) => setTimeout(r, 40));
  assert.deepEqual(ev, ["start:a"]);
  a.finish();
  await tick();
  q.close();
});

test("queue: stop は parent-id の動いている物と待っている物を全部外す（他の cap は残る）", async () => {
  const ev: string[] = [];
  const q = createWorkQueue(opts({ maxParallel: 1 }));
  const a1 = makeJob("launch", "capA", "a1", ev);
  const a2 = makeJob("launch", "capA", "a2", ev);
  const a3 = makeJob("reply", "capA", "a3", ev);
  const b1 = makeJob("launch", "capB", "b1", ev);
  for (const j of [a1, a2, a3, b1]) q.submit(j);
  assert.deepEqual(ev, ["start:a1"]);
  const r = q.stop("capA");
  assert.deepEqual(r, { running: 1, queued: 2 });
  assert.equal(a1.aborted, true);
  assert.equal(a2.cancelledCalled, true);
  assert.equal(a3.cancelledCalled, true);
  await tick();
  // a1 が終わり、待っていた capB の b1 が起きる。a2 / a3 は起きない
  assert.deepEqual(ev, ["start:a1", "start:b1"]);
  assert.deepEqual(q.stop("nobody"), { running: 0, queued: 0 });
  b1.finish();
  await tick();
  q.close();
});

test("queue: job の start が reject しても queue は止まらない", async () => {
  const ev: string[] = [];
  const logs: string[] = [];
  const q = createWorkQueue(opts({ maxParallel: 1, log: (m) => logs.push(m) }));
  const bad: Job = { kind: "launch", parentId: "cap", sessionId: "bad", start: () => Promise.reject(new Error("boom")), abort() {} };
  const good = makeJob("launch", "cap", "g", ev);
  q.submit(bad);
  q.submit(good);
  await tick();
  assert.deepEqual(ev, ["start:g"]);
  assert.ok(logs.some((l) => l.includes("boom")));
  good.finish();
  await tick();
  q.close();
});
