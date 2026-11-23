import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkQueue, type Job } from "../../../../server/utils/bantou/queue";
import { PENDING_FILE, clearPending, takePending, writePending } from "../../../../server/utils/bantou/pending";
import { buildSpec, compareVersions, createSelfUpdater, fetchLatestVersion, readUpdateFile, writeUpdateFile } from "../../../../server/utils/bantou/update";
import { workerDir } from "../../../../server/utils/bantou/paths";
import type { WorkerRunInput } from "../../../../server/utils/bantou/worker";

const tick = (ms = 0): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function withWs<T>(fn: (ws: string) => Promise<T>): Promise<T> {
  const ws = await mkdtemp(join(tmpdir(), "upd-"));
  try {
    return await fn(ws);
  } finally {
    await rm(ws, { recursive: true, force: true });
  }
}

function input(ws: string, id: string, over: Partial<WorkerRunInput> = {}): WorkerRunInput {
  return { workerId: id, dir: workerDir(ws, id), parentId: "cap-1", ws: "ws://h:7910/ws/worker?token=SECRET", mode: "new", sessionId: `s-${id}`, prompt: "p", ...over };
}

/** 手で終わらせられる job（input 付き）。 */
function job(kind: "launch" | "reply", inp: WorkerRunInput, events: string[]): Job & { finish(): void } {
  let done!: () => void;
  const p = new Promise<void>((r) => (done = r));
  const j = {
    kind,
    parentId: inp.parentId,
    workerId: inp.workerId,
    input: inp,
    start: () => {
      events.push(`start:${inp.workerId}`);
      return p;
    },
    abort: () => {
      events.push(`abort:${inp.workerId}`);
      done();
    },
    finish: () => done(),
  };
  return j;
}

const qopts = (maxParallel = 2) => ({ maxParallel, cpus: () => 4, loadavg1: () => 0, pollMs: 10 });

test("compareVersions: x.y.z を数値で比べる（0.6.12 < 0.7.0、0.10.0 > 0.9.9）", () => {
  assert.ok(compareVersions("0.7.0", "0.6.12") > 0);
  assert.ok(compareVersions("0.6.12", "0.7.0") < 0);
  assert.ok(compareVersions("0.10.0", "0.9.9") > 0);
  assert.ok(compareVersions("1.0.0", "0.99.99") > 0);
  assert.equal(compareVersions("0.6.12", "0.6.12"), 0);
});

test("fetchLatestVersion: 取得元の {version} を latest にして npx で --version を見る。出力が x.y.z でなければ投げる", async () => {
  const calls: Array<{ cmd: string; args: string[] }> = [];
  const ok = await fetchLatestVersion("bantou@{version}", async (cmd, args) => {
    calls.push({ cmd, args });
    return { stdout: "npm notice\n0.7.1\n" };
  });
  assert.equal(ok, "0.7.1");
  assert.deepEqual(calls, [{ cmd: "npx", args: ["-y", "--package=bantou@latest", "--", "bantou", "--version"] }]);
  await assert.rejects(fetchLatestVersion("bantou@{version}", async () => ({ stdout: "0.7.1-beta.1\n" })), /x\.y\.z でない/);
  await assert.rejects(fetchLatestVersion("bantou@{version}", async () => ({ stdout: "" })), /x\.y\.z でない/);
  assert.equal(buildSpec("bantou@{version}", "0.7.1"), "bantou@0.7.1");
});

test("pending: 待ちの launch / reply を 0600 の file に持ち、読むと消える。不正な項目と workspace 外の dir は外す", async () => {
  await withWs(async (ws) => {
    const q = createWorkQueue(qopts(1));
    const ev: string[] = [];
    const run = job("launch", input(ws, "w-run"), ev);
    const l1 = job("launch", input(ws, "w-l1"), ev);
    const r1 = job("reply", input(ws, "w-r1", { mode: "resume", prompt: "ans" }), ev);
    for (const j of [run, l1, r1]) q.submit(j);
    q.pause();
    assert.equal(await writePending(ws, q.waiting()), 2);
    assert.equal((await stat(join(ws, PENDING_FILE))).mode & 0o777, 0o600);
    const got = await takePending(ws);
    assert.deepEqual(got.jobs.map((j) => [j.kind, j.input.workerId]), [["reply", "w-r1"], ["launch", "w-l1"]]);
    assert.equal(got.jobs[0]!.input.mode, "resume");
    assert.equal(got.skipped, 0);
    // 読んでも file は消えない（全部 submit し終えてから clearPending で消す）
    assert.equal((await stat(join(ws, PENDING_FILE))).isFile(), true);
    assert.equal((await takePending(ws)).jobs.length, 2);
    await clearPending(ws);
    assert.deepEqual(await takePending(ws), { jobs: [], skipped: 0 });
    run.finish();
    q.close();

    // 壊れた項目・workspace 外の dir
    const evil = [{ kind: "launch", input: input(ws, "w-x", { dir: "/etc" }) }, { kind: "launch", input: { workerId: 1 } }, { kind: "launch", input: input(ws, "w-ok") }];
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(ws, PENDING_FILE), JSON.stringify({ jobs: evil }));
    const r = await takePending(ws);
    assert.deepEqual(r.jobs.map((j) => j.input.workerId), ["w-ok"]);
    assert.equal(r.skipped, 2);
  });
});

test("queue: pause 中も reply の起こし直しは取り出す（新しい launch だけ止める）", async () => {
  const q = createWorkQueue(qopts(3));
  const ev: string[] = [];
  const a = job("launch", input("/w", "w-a"), ev);
  q.submit(a);
  q.pause();
  const l = job("launch", input("/w", "w-l"), ev);
  const r = job("reply", input("/w", "w-r", { mode: "resume" }), ev);
  q.submit(l);
  q.submit(r);
  assert.deepEqual(ev, ["start:w-a", "start:w-r"]);
  assert.deepEqual(q.waiting().map((j) => j.workerId), ["w-l"]);
  // 同じ worker が動いている間の reply は待つ（pause 中でも、終われば取り出す）
  const r2 = job("reply", input("/w", "w-a", { mode: "resume" }), ev);
  q.submit(r2);
  assert.deepEqual(ev, ["start:w-a", "start:w-r"]);
  a.finish();
  await tick(20);
  assert.deepEqual(ev, ["start:w-a", "start:w-r", "start:w-a"]);
  for (const j of [r, r2]) j.finish();
  q.close();
});

test("queue: pause すると新しい launch を取り出さない（submit は待たせる）。resume で再開する", async () => {
  const q = createWorkQueue(qopts(2));
  const ev: string[] = [];
  const ws = "/w";
  const a = job("launch", input(ws, "w-a"), ev);
  q.submit(a);
  q.pause();
  const b = job("launch", input(ws, "w-b"), ev);
  q.submit(b);
  assert.deepEqual(ev, ["start:w-a"]);
  assert.deepEqual(q.counts(), { running: 1, queued: 1 });
  a.finish();
  await tick();
  assert.deepEqual(ev, ["start:w-a"]);
  q.resume();
  assert.deepEqual(ev, ["start:w-a", "start:w-b"]);
  b.finish();
  q.close();
});

function updaterSetup(ws: string, over: { latest?: string | (() => string); maxWaitMs?: number; version?: string } = {}) {
  const q = createWorkQueue(qopts(2));
  const logs: string[] = [];
  const exits: string[] = [];
  let fetchCount = 0;
  const u = createSelfUpdater({
    workspace: ws,
    serverVersion: over.version ?? "0.6.12",
    update: { spec: "bantou@{version}", checkIntervalMs: 600_000, maxWaitMs: over.maxWaitMs ?? 1_800_000 },
    queue: q,
    fetchLatest: async () => {
      fetchCount++;
      const l = over.latest ?? "0.7.0";
      return typeof l === "function" ? l() : l;
    },
    requestExit: (r) => exits.push(r),
    log: (m) => logs.push(m),
    pollMs: 5,
  });
  return { q, u, logs, exits, fetchCount: () => fetchCount };
}

test("自己更新: 最新版が同じか古ければ何もしない（待たず、止めず、終了も頼まない）", async () => {
  await withWs(async (ws) => {
    for (const latest of ["0.6.12", "0.6.11"]) {
      const { q, u, logs, exits } = updaterSetup(ws, { latest });
      const ev: string[] = [];
      q.submit(job("launch", input(ws, "w-a"), ev));
      await u.check();
      assert.deepEqual(exits, []);
      assert.equal(u.updating(), false);
      assert.deepEqual(logs, []);
      assert.deepEqual(await readUpdateFile(ws), undefined);
      q.close();
    }
  });
});

test("自己更新: 新しい版を見つけたら launch を取り出すのをやめ、動いている worker が終わるのを待ち、queue を file に持って update.json に restart を書いて終了を頼む", async () => {
  await withWs(async (ws) => {
    const { q, u, logs, exits } = updaterSetup(ws);
    const ev: string[] = [];
    const running = job("launch", input(ws, "w-run"), ev);
    q.submit(running);
    const checking = u.check();
    await tick(20);
    // 待っている間に来た launch は取り出されない
    const late = job("launch", input(ws, "w-late"), ev);
    q.submit(late);
    await tick(20);
    assert.deepEqual(ev, ["start:w-run"]);
    assert.deepEqual(exits, []);
    assert.equal(u.updating(), true);
    assert.deepEqual(await readUpdateFile(ws), undefined);
    running.finish();
    await checking;
    assert.deepEqual(exits, ["update"]);
    assert.deepEqual(ev, ["start:w-run"]);
    assert.deepEqual(await readUpdateFile(ws), { state: "restart", to: "0.7.0", spec: "bantou@0.7.0" });
    const p = await takePending(ws);
    assert.deepEqual(p.jobs.map((j) => j.input.workerId), ["w-late"]);
    assert.ok(logs.some((l) => l.includes("版 0.7.0 を見つけた")));
    assert.ok(logs.some((l) => l.includes("待っている（worker 1）")));
    assert.ok(logs.some((l) => l.includes("入れ替える")));
    // 認証の値（ws の token）は log に出ない
    assert.equal(logs.some((l) => l.includes("SECRET")), false);
    q.close();
  });
});

test("自己更新: 待ちの上限を越えたら、残りの worker を止めて進む", async () => {
  await withWs(async (ws) => {
    const { q, u, logs, exits } = updaterSetup(ws, { maxWaitMs: 50 });
    const ev: string[] = [];
    q.submit(job("launch", input(ws, "w-stuck"), ev));
    await u.check();
    assert.deepEqual(ev, ["start:w-stuck", "abort:w-stuck"]);
    assert.deepEqual(exits, ["update"]);
    assert.ok(logs.some((l) => l.includes("上限") && l.includes("止めて進む")));
    assert.deepEqual((await readUpdateFile(ws))?.state, "restart");
    q.close();
  });
});

test("自己更新: 入れ替えの終了の途中で増えた待ちも flush で file に持ち直す。入れ替えに入っていなければ flush は何もしない", async () => {
  await withWs(async (ws) => {
    const idle = updaterSetup(ws, { latest: "0.6.12" });
    await idle.u.check();
    await idle.u.flush();
    assert.deepEqual(await takePending(ws), { jobs: [], skipped: 0 });
    idle.q.close();

    const { q, u } = updaterSetup(ws);
    await u.check();
    assert.equal(u.updating(), true);
    const ev: string[] = [];
    q.submit(job("launch", input(ws, "w-after"), ev));
    await u.flush();
    const p = await takePending(ws);
    assert.deepEqual(p.jobs.map((j) => j.input.workerId), ["w-after"]);
    assert.deepEqual(ev, []);
    q.close();
  });
});

test("自己更新: 最新版を確認できなければ log に残して続ける。supervisor が起動できなかったと記録した版は見送る", async () => {
  await withWs(async (ws) => {
    const logs: string[] = [];
    const bad = createSelfUpdater({
      workspace: ws,
      serverVersion: "0.6.12",
      update: { spec: "bantou@{version}", checkIntervalMs: 600_000, maxWaitMs: 1000 },
      queue: createWorkQueue(qopts()),
      fetchLatest: async () => {
        throw new Error("network down");
      },
      requestExit: () => assert.fail("終了しない"),
      log: (m) => logs.push(m),
    });
    await bad.check();
    assert.ok(logs.some((l) => l.includes("最新版を確認できない: network down")));
    assert.equal(bad.updating(), false);

    await writeUpdateFile(ws, { state: "failed", to: "0.7.0", error: "起動できない", at: "2026-11-23T00:00:00.000Z" });
    const { u, exits, logs: l2 } = updaterSetup(ws);
    u.start();
    await tick(30);
    await u.check();
    u.close();
    assert.deepEqual(exits, []);
    assert.ok(l2.some((l) => l.includes("前回起動できなかった")));
  });
});

test("自己更新: 取り消し（close）されたら待ちを解いて queue を再開する", async () => {
  await withWs(async (ws) => {
    const { q, u, exits, logs } = updaterSetup(ws);
    const ev: string[] = [];
    const a = job("launch", input(ws, "w-a"), ev);
    q.submit(a);
    const checking = u.check();
    await tick(20);
    u.close();
    // 停止が来た後に worker が終わっても「入れ替える」に進まない
    a.finish();
    await checking;
    assert.deepEqual(exits, []);
    assert.equal(logs.some((l) => l.startsWith("入れ替える:")), false);
    assert.deepEqual(await readUpdateFile(ws), undefined);
    a.finish();
    q.close();
    assert.equal(u.updating(), false);
  });
});
