import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChangeGate, StepStatus } from "../../../../server/utils/bantou/change-gate";
import { createAdmission } from "../../../../server/utils/bantou/change-resources";
import {
  ABNORMAL_EXIT_NOTE,
  buildRestartPrompt,
  buildRetryPrompt,
  buildStepPrompt,
  createChangeRunner,
  type ChangeNotice,
  type ChangeRunner,
  type LaunchRequest,
  type LaunchResult,
} from "../../../../server/utils/bantou/change-runner";
import { createChangeStore, type ChangeStore } from "../../../../server/utils/bantou/change-store";

interface Pending {
  req: LaunchRequest;
  finish: (r: LaunchResult) => void;
}

interface Fx {
  ws: string;
  store: ChangeStore;
  runner: ChangeRunner;
  launches: Pending[];
  notices: ChangeNotice[];
  stopped: string[];
  gateCalls: Array<[string, string]>;
  /** gate が次に返す物（先頭から使う。尽きたら done / complete）。 */
  gateQueue: Array<StepStatus | Error>;
  limits: { maxParallelWorkers?: number; minFreeMemoryBytes?: number };
  memFree: { v: number | null };
  gateWhy: { v: string | undefined };
}

const PASS: StepStatus = { artifact: "done", apply: { done: 2, total: 2, complete: true } };
const FAIL: StepStatus = { artifact: "done", apply: { done: 1, total: 2, complete: false } };

function makeRunner(ws: string, f: Partial<Fx> & Pick<Fx, "launches" | "notices" | "stopped" | "gateCalls" | "gateQueue" | "limits" | "memFree" | "gateWhy">): { runner: ChangeRunner; store: ChangeStore } {
  const store = createChangeStore(ws, () => {});
  const gate: ChangeGate = {
    unavailable: () => f.gateWhy.v,
    status: async (changeId, ref) => {
      f.gateCalls.push([changeId, ref]);
      const n = f.gateQueue.shift() ?? PASS;
      if (n instanceof Error) throw n;
      return n;
    },
  };
  const runner = createChangeRunner({
    store,
    gate,
    admission: createAdmission(f.limits, () =>
      f.memFree.v === null
        ? null
        : { at: "", load1: 0, load5: 0, load15: 0, cpus: 1, mem_total: 100, mem_free: f.memFree.v, disk_total: null, disk_free: null, workers: 0 },
    ),
    launch: (req) =>
      new Promise<LaunchResult>((resolve) => {
        f.launches.push({ req, finish: resolve });
      }),
    stopWorker: async (id) => (f.stopped.push(id), { stopped: true }),
    notify: async (_to, n) => {
      f.notices.push(n);
    },
    log: () => {},
  });
  return { runner, store };
}

async function withRunner(fn: (f: Fx) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "bantou-change-test-"));
  try {
    const base = {
      launches: [] as Pending[],
      notices: [] as ChangeNotice[],
      stopped: [] as string[],
      gateCalls: [] as Array<[string, string]>,
      gateQueue: [] as Array<StepStatus | Error>,
      limits: {} as Fx["limits"],
      memFree: { v: null as number | null },
      gateWhy: { v: undefined as string | undefined },
    };
    const { runner, store } = makeRunner(dir, base);
    await fn({ ws: dir, store, runner, ...base });
    await store.flush();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** assert の型の絞り込みを受けずに通知を取り出す。 */
const noticeAt = (f: Fx, i: number): ChangeNotice => f.notices[i]!;

const reg = (id: string, scope: string[], extra: Record<string, unknown> = {}) => ({
  change_id: id,
  scope,
  repo: "https://example.invalid/r.git",
  notify_id: "n1",
  notify_to: { id: "p1", name: "bantou-center" },
  ...extra,
});

/** 起こされた worker の run を ok で終わらせ、確かめまで流す。 */
async function endRun(f: Fx, i: number, r: LaunchResult = { ok: true, session_id: `s${i}` }): Promise<void> {
  f.launches[i]!.finish(r);
  // run の終わりの continuation（microtask）が回ってから、後始末を待つ
  await new Promise((resolve) => setImmediate(resolve));
  await f.runner.idle();
}

test("登録: 先頭の step だけ起こし、残りは pending。指示文は change の名前と step の参照だけ", async () => {
  await withRunner(async (f) => {
    const r = await f.runner.register(reg("ch1", ["a", "b"], { branch: "dev", worker_model: "sonnet" }));
    assert.equal(r.state, "in_progress");
    assert.equal(f.launches.length, 1);
    const req = f.launches[0]!.req;
    assert.deepEqual(req, {
      change_id: "ch1",
      step: 0,
      worker_id: "ch1-s0",
      prompt: buildStepPrompt("ch1", "a"),
      repo: "https://example.invalid/r.git",
      branch: "dev",
      model: "sonnet",
    });
    assert.equal(req.prompt, "change: ch1\nstep: a\nこの step の範囲だけを行う。");
    const [info] = f.runner.status("ch1");
    assert.deepEqual(info!.steps.map((s) => s.state), ["running", "pending"]);
    assert.equal(info!.step, 0);
    assert.deepEqual(f.notices, []);
  });
});

test("step は scope の順に 1 つずつ。通れば次、最後が通れば completed を 1 度だけ知らせる", async () => {
  await withRunner(async (f) => {
    await f.runner.register(reg("ch1", ["a", "b"]));
    await endRun(f, 0);
    assert.deepEqual(f.gateCalls, [["ch1", "a"]]);
    assert.equal(f.launches.length, 2);
    assert.equal(f.launches[1]!.req.step, 1);
    assert.equal(f.launches[1]!.req.worker_id, "ch1-s1");
    assert.equal(f.launches[1]!.req.prompt, buildStepPrompt("ch1", "b"));
    assert.deepEqual(f.notices, []);
    await endRun(f, 1);
    const [info] = f.runner.status("ch1");
    assert.equal(info!.state, "completed");
    assert.deepEqual(info!.steps.map((s) => s.state), ["passed", "passed"]);
    assert.deepEqual(info!.steps.map((s) => s.session_id), ["s0", "s1"]);
    assert.equal(f.notices.length, 1);
    const n = noticeAt(f, 0);
    assert.equal(n.type, "change_progress");
    if (n.type === "change_progress") {
      assert.equal(n.change_state, "completed");
      assert.equal(n.step_state, "passed");
      assert.equal(n.step, 1);
      assert.equal(n.notify_id, "n1");
    }
  });
});

test("確かめに通らない: 同じ worker・同じ step を、通らなかった中身つきで起こし直す。何度でも。center には知らせない", async () => {
  await withRunner(async (f) => {
    f.gateQueue.push(FAIL, FAIL, PASS);
    await f.runner.register(reg("ch1", ["a"]));
    await endRun(f, 0);
    assert.equal(f.launches.length, 2);
    assert.equal(f.launches[1]!.req.worker_id, "ch1-s0");
    assert.equal(f.launches[1]!.req.prompt, buildRetryPrompt("ch1", "a", "apply の進みが 1/2（complete でない）"));
    assert.match(f.launches[1]!.req.prompt, /1\/2/);
    assert.equal(f.runner.status("ch1")[0]!.state, "in_progress");
    await endRun(f, 1);
    assert.equal(f.launches.length, 3);
    assert.equal(f.launches[2]!.req.worker_id, "ch1-s0");
    assert.deepEqual(f.notices, []);
    await endRun(f, 2);
    assert.equal(f.runner.status("ch1")[0]!.state, "completed");
    assert.equal(f.notices.length, 1);
  });
});

test("質問: waiting_reply にして change_report を知らせ、run が終わっても確かめない。返答で同じ worker を起こし直す", async () => {
  await withRunner(async (f) => {
    await f.runner.register(reg("ch1", ["a"]));
    await f.runner.reported("ch1", "ch1-s0", "ask", "どちらにする？");
    assert.equal(f.runner.status("ch1")[0]!.steps[0]!.state, "waiting_reply");
    assert.equal(f.notices.length, 1);
    const n = f.notices[0]!;
    assert.equal(n.type, "change_report");
    if (n.type === "change_report") {
      assert.deepEqual([n.change_id, n.worker_id, n.step, n.kind, n.text], ["ch1", "ch1-s0", 0, "ask", "どちらにする？"]);
    }
    await endRun(f, 0, { ok: true, session_id: "sess-q" });
    assert.deepEqual(f.gateCalls, []);
    assert.equal(f.launches.length, 1);
    // session-id は step に結び付いて残る
    assert.equal(f.runner.status("ch1")[0]!.steps[0]!.session_id, "sess-q");
    await f.runner.reply("ch1", "ch1-s0", "A にして");
    assert.equal(f.launches.length, 2);
    assert.equal(f.launches[1]!.req.worker_id, "ch1-s0");
    assert.equal(f.launches[1]!.req.prompt, "A にして");
    assert.equal(f.runner.status("ch1")[0]!.steps[0]!.state, "running");
    await endRun(f, 1);
    assert.equal(f.runner.status("ch1")[0]!.state, "completed");
  });
});

test("質問の後、古い run の終わりが返答の起こし直しより遅れても、新しい起動を確かめに回さない", async () => {
  await withRunner(async (f) => {
    await f.runner.register(reg("ch1", ["a"]));
    await f.runner.reported("ch1", "ch1-s0", "approve", "進めてよい？");
    await f.runner.reply("ch1", "ch1-s0", "よい");
    assert.equal(f.launches.length, 2);
    // 1 回目の run が今ごろ終わる
    await endRun(f, 0);
    assert.deepEqual(f.gateCalls, []);
    assert.equal(f.runner.status("ch1")[0]!.steps[0]!.state, "running");
  });
});

test("返答できない時は error: worker が違う・返答待ちでない・change が無い", async () => {
  await withRunner(async (f) => {
    await f.runner.register(reg("ch1", ["a"]));
    await assert.rejects(() => f.runner.reply("ch1", "ch1-s0", "x"), /返答待ちではない/);
    await assert.rejects(() => f.runner.reply("ch1", "nope", "x"), /step の worker でない/);
    await assert.rejects(() => f.runner.reply("zzz", "ch1-s0", "x"), /change が無い/);
    await assert.rejects(() => f.runner.reported("ch1", "nope", "ask", "x"), /step の worker でない/);
  });
});

test("progress / done の report は知らせず、change の状態も変えない", async () => {
  await withRunner(async (f) => {
    await f.runner.register(reg("ch1", ["a"]));
    await f.runner.reported("ch1", "ch1-s0", "progress", "半分");
    await f.runner.reported("ch1", "ch1-s0", "done", "終わり");
    assert.deepEqual(f.notices, []);
    assert.equal(f.runner.status("ch1")[0]!.steps[0]!.state, "running");
  });
});

test("stop_change: 動いている worker を止め、step を stopped にし、止められた事を 1 度だけ知らせる。以後は起こさない", async () => {
  await withRunner(async (f) => {
    await f.runner.register(reg("ch1", ["a", "b"]));
    const r = await f.runner.stop("ch1");
    assert.deepEqual(r, { stopped: true });
    assert.deepEqual(f.stopped, ["ch1-s0"]);
    const [info] = f.runner.status("ch1");
    assert.equal(info!.state, "stopped");
    assert.equal(info!.reason, "stop_change");
    assert.deepEqual(info!.steps.map((s) => s.state), ["stopped", "stopped"]);
    assert.equal(f.notices.length, 1);
    const n = f.notices[0]!;
    assert.equal(n.type, "change_progress");
    if (n.type === "change_progress") assert.deepEqual([n.change_state, n.step_state, n.reason], ["stopped", "stopped", "stop_change"]);
    // 止められた worker の run の終わりは、異常終了とも確かめとも見ない
    await endRun(f, 0, { ok: false, error: "stop により停止" });
    assert.equal(f.notices.length, 1);
    assert.deepEqual(f.gateCalls, []);
    assert.equal(f.launches.length, 1);
    // もう止まっている change は stopped: false
    assert.deepEqual(await f.runner.stop("ch1"), { stopped: false });
    await assert.rejects(() => f.runner.stop("nope"), /change が無い/);
  });
});

test("stop_change: worker を止められなければ error で、change の状態は変えない", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bantou-change-test-"));
  try {
    const launches: Array<() => void> = [];
    const notices: ChangeNotice[] = [];
    const store = createChangeStore(dir, () => {});
    const runner = createChangeRunner({
      store,
      gate: { unavailable: () => undefined, status: async () => PASS },
      admission: createAdmission({}, () => null),
      launch: () => new Promise<LaunchResult>((r) => launches.push(() => r({ ok: true }))),
      stopWorker: async () => {
        throw new Error("kill 失敗");
      },
      notify: async (_t, n) => void notices.push(n),
      log: () => {},
    });
    await runner.register(reg("ch1", ["a"]));
    await assert.rejects(() => runner.stop("ch1"), /worker_id=ch1-s0.*kill 失敗/);
    assert.equal(runner.status("ch1")[0]!.state, "in_progress");
    assert.deepEqual(notices, []);
    await store.flush();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("worker の異常終了（仮の扱い）: change を止めて知らせる。起こし直さない", async () => {
  await withRunner(async (f) => {
    await f.runner.register(reg("ch1", ["a", "b"]));
    await endRun(f, 0, { ok: false, session_id: "s0", error: "claude が落ちた" });
    const [info] = f.runner.status("ch1");
    assert.equal(info!.state, "stopped");
    assert.match(info!.reason!, /claude が落ちた/);
    assert.ok(info!.reason!.includes(ABNORMAL_EXIT_NOTE));
    assert.equal(f.launches.length, 1);
    assert.deepEqual(f.gateCalls, []);
    assert.equal(f.notices.length, 1);
    assert.equal(f.notices[0]!.type, "change_progress");
  });
});

test("launch が投げた時（clone 失敗など）も異常終了として change を止める", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bantou-change-test-"));
  try {
    const notices: ChangeNotice[] = [];
    const store = createChangeStore(dir, () => {});
    const runner = createChangeRunner({
      store,
      gate: { unavailable: () => undefined, status: async () => PASS },
      admission: createAdmission({}, () => null),
      launch: async () => {
        throw new Error("clone できない");
      },
      stopWorker: async () => ({ stopped: false }),
      notify: async (_t, n) => void notices.push(n),
      log: () => {},
    });
    await runner.register(reg("ch1", ["a"]));
    await runner.idle();
    assert.equal(runner.status("ch1")[0]!.state, "stopped");
    assert.match(runner.status("ch1")[0]!.reason!, /clone できない/);
    assert.equal(notices.length, 1);
    await store.flush();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("確かめを実行できない（openspec-mcp に聞けない）時は、同じ事を繰り返さず change を止めて知らせる", async () => {
  await withRunner(async (f) => {
    f.gateQueue.push(new Error("接続できない"));
    await f.runner.register(reg("ch1", ["a"]));
    await endRun(f, 0);
    assert.equal(f.runner.status("ch1")[0]!.state, "stopped");
    assert.match(f.runner.status("ch1")[0]!.reason!, /接続できない/);
    assert.equal(f.launches.length, 1);
    assert.equal(f.notices.length, 1);
  });
});

test("openspec-mcp が使えない時は登録を断る。進行中の change の再登録も断る", async () => {
  await withRunner(async (f) => {
    f.gateWhy.v = "未設定";
    await assert.rejects(() => f.runner.register(reg("ch1", ["a"])), /未設定/);
    assert.deepEqual(f.runner.status(), []);
    f.gateWhy.v = undefined;
    await f.runner.register(reg("ch1", ["a"]));
    await assert.rejects(() => f.runner.register(reg("ch1", ["b"])), /進行中/);
  });
});

test("再登録: completed の change に新しい scope を足せる。前の step は変えず、位置は新しい scope の先頭", async () => {
  await withRunner(async (f) => {
    await f.runner.register(reg("ch1", ["a"]));
    await endRun(f, 0);
    assert.equal(f.runner.status("ch1")[0]!.state, "completed");
    const r = await f.runner.register(reg("ch1", ["c", "d"]));
    assert.equal(r.state, "in_progress");
    const [info] = f.runner.status("ch1");
    assert.deepEqual(info!.steps.map((s) => [s.ref, s.state]), [["a", "passed"], ["c", "running"], ["d", "pending"]]);
    assert.equal(info!.step, 1);
    assert.equal(f.launches[1]!.req.worker_id, "ch1-s1");
    await endRun(f, 1);
    await endRun(f, 2);
    assert.equal(f.runner.status("ch1")[0]!.state, "completed");
    assert.equal(f.notices.length, 2);
  });
});

test("再登録: stopped の change も動かし直せる", async () => {
  await withRunner(async (f) => {
    await f.runner.register(reg("ch1", ["a"]));
    await f.runner.stop("ch1");
    await f.runner.register(reg("ch1", ["a"]));
    const [info] = f.runner.status("ch1");
    assert.equal(info!.state, "in_progress");
    assert.equal(info!.reason, undefined);
    assert.deepEqual(info!.steps.map((s) => s.state), ["stopped", "running"]);
    // 現在の step は、止まった前の scope の step ではなく、新しい scope の先頭
    assert.equal(info!.step, 1);
  });
});

test("並行の上限: 超えた分は queue に待ち、来た順に起きる（change をまたいで）", async () => {
  await withRunner(async (f) => {
    f.limits.maxParallelWorkers = 1;
    await f.runner.register(reg("c1", ["a"]));
    await f.runner.register(reg("c2", ["a"]));
    await f.runner.register(reg("c3", ["a"]));
    assert.deepEqual(f.launches.map((l) => l.req.change_id), ["c1"]);
    assert.deepEqual(f.runner.counts(), { queued: 2, running: 1, waiting_reply: 0 });
    assert.equal(f.runner.status("c2")[0]!.steps[0]!.state, "queued");
    await endRun(f, 0);
    assert.deepEqual(f.launches.map((l) => l.req.change_id), ["c1", "c2"]);
    await endRun(f, 1);
    assert.deepEqual(f.launches.map((l) => l.req.change_id), ["c1", "c2", "c3"]);
  });
});

test("質問待ちの worker は並行の数に数えない", async () => {
  await withRunner(async (f) => {
    f.limits.maxParallelWorkers = 1;
    await f.runner.register(reg("c1", ["a"]));
    await f.runner.register(reg("c2", ["a"]));
    await f.runner.reported("c1", "c1-s0", "ask", "?");
    // c1 の run が終われば（process が無くなれば）c2 が起きる。c1 は返答待ちのまま
    await endRun(f, 0);
    assert.deepEqual(f.launches.map((l) => l.req.change_id), ["c1", "c2"]);
    assert.equal(f.runner.counts().waiting_reply, 1);
  });
});

test("メモリの空きが下限を下回る間は起こさない。空けば pump で起こす（測れない時は止めない）", async () => {
  await withRunner(async (f) => {
    f.limits.minFreeMemoryBytes = 50;
    f.memFree.v = 10;
    await f.runner.register(reg("c1", ["a"]));
    assert.equal(f.launches.length, 0);
    assert.equal(f.runner.status("c1")[0]!.steps[0]!.state, "queued");
    f.runner.pump();
    assert.equal(f.launches.length, 0);
    f.memFree.v = 80;
    f.runner.pump();
    assert.equal(f.launches.length, 1);
    f.memFree.v = null;
    await f.runner.register(reg("c2", ["a"]));
    assert.equal(f.launches.length, 2);
  });
});

test("上限を置かなければ並行に上限は無い", async () => {
  await withRunner(async (f) => {
    for (let i = 0; i < 6; i++) await f.runner.register(reg(`c${i}`, ["a"]));
    assert.equal(f.launches.length, 6);
  });
});

test("記録は file に残り、再起動後も step の位置・worker_id・session_id・返答待ちが残る", async () => {
  await withRunner(async (f) => {
    await f.runner.register(reg("ch1", ["a", "b"]));
    await endRun(f, 0, { ok: true, session_id: "S0" });
    await f.runner.reported("ch1", "ch1-s1", "ask", "?");
    await f.runner.idle();
    // 別の runner（再起動後）が同じ workspace を読む
    const launches: Pending[] = [];
    const againStore = createChangeStore(f.ws, () => {});
    const again = createChangeRunner({
      store: againStore,
      gate: { unavailable: () => undefined, status: async () => PASS },
      admission: createAdmission({}, () => null),
      launch: (req) => new Promise<LaunchResult>((r) => launches.push({ req, finish: r })),
      stopWorker: async () => ({ stopped: false }),
      notify: async () => {},
      log: () => {},
    });
    assert.equal(await again.load(), 1);
    const [info] = again.status("ch1");
    assert.equal(info!.step, 1);
    assert.deepEqual(info!.steps.map((s) => [s.worker_id, s.session_id, s.state]), [["ch1-s0", "S0", "passed"], ["ch1-s1", undefined, "waiting_reply"]]);
    assert.equal(launches.length, 0);
    // 再起動後でも返答で続きを起こせる
    await again.reply("ch1", "ch1-s1", "続けて");
    assert.equal(launches[0]!.req.worker_id, "ch1-s1");
    assert.equal(launches[0]!.req.prompt, "続けて");
    await againStore.flush();
  });
});

test("再起動で中断した running の step は、同じ worker で続きを起こす。queue の順番も保つ", async () => {
  await withRunner(async (f) => {
    f.limits.maxParallelWorkers = 1;
    await f.runner.register(reg("c1", ["a"]));
    await f.runner.register(reg("c2", ["a"]));
    await f.runner.register(reg("c3", ["a"]));
    await f.store.flush();
    const launches: Pending[] = [];
    const againStore = createChangeStore(f.ws, () => {});
    const again = createChangeRunner({
      store: againStore,
      gate: { unavailable: () => undefined, status: async () => PASS },
      admission: createAdmission({ maxParallelWorkers: 1 }, () => null),
      launch: (req) => new Promise<LaunchResult>((r) => launches.push({ req, finish: r })),
      stopWorker: async () => ({ stopped: false }),
      notify: async () => {},
      log: () => {},
    });
    await again.load();
    assert.deepEqual(launches.map((l) => l.req.change_id), ["c1"]);
    assert.equal(launches[0]!.req.worker_id, "c1-s0");
    assert.equal(launches[0]!.req.prompt, buildRestartPrompt("c1", "a"));
    launches[0]!.finish({ ok: true });
    await again.idle();
    assert.deepEqual(launches.map((l) => l.req.change_id), ["c1", "c2"]);
    await againStore.flush();
  });
});

test("close 後は、終わった run の結果で記録を変えず、次を起こさない", async () => {
  await withRunner(async (f) => {
    await f.runner.register(reg("ch1", ["a", "b"]));
    f.runner.close();
    await endRun(f, 0, { ok: false, error: "server 終了" });
    assert.equal(f.runner.status("ch1")[0]!.steps[0]!.state, "running");
    assert.equal(f.notices.length, 0);
    await assert.rejects(() => f.runner.register(reg("zz", ["a"])), /止まる/);
  });
});

test("change_status: 引数なしで全部、change_id で 1 つ。無ければ error", async () => {
  await withRunner(async (f) => {
    await f.runner.register(reg("b1", ["a"]));
    await f.runner.register(reg("a1", ["a"]));
    assert.deepEqual(f.runner.status().map((c) => c.change_id), ["a1", "b1"]);
    assert.throws(() => f.runner.status("zz"), /change が無い/);
  });
});
