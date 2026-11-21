import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ActivityNotice } from "@agent-hand/bantou-protocol";
import { createActivityTracker } from "../../../../server/utils/bantou/activity";
import { STOP_MSG, type RunObserver } from "../../../../server/utils/bantou/agents";
import { agentDir } from "../../../../server/utils/bantou/paths";
import { writeState } from "../../../../server/utils/bantou/state";
import { writeOwner } from "../../../../server/utils/bantou/workers";
import { buildExitPrompt, createWorkerExitWatcher } from "../../../../server/utils/bantou/worker-exit";
import { CAP_GUIDE } from "../../../../server/utils/bantou/prompts";

const settle = (): Promise<void> => new Promise((r) => setImmediate(r));
const T0 = "2026-11-20T00:00:00.000Z";
const T1 = "2026-11-20T00:10:00.000Z";

/** 今の center（古い版）と同じ判定の偽物: activity で cap も worker も running でなく、未完了の指示があれば完了にして 1 回数える。 */
function fakeCenter() {
  const state = { cap: "idle", workers: new Map<string, string>() };
  const c = { completions: 0, pending: 1, events: [] as string[], got: "none" as "none" | "failed", completedAs: [] as string[] };
  const complete = (why: string): void => {
    const busy = state.cap === "running" || state.cap === "stalled" || [...state.workers.values()].some((s) => s === "running" || s === "stalled");
    if (busy || c.pending === 0) return;
    c.pending = 0;
    c.completions++;
    c.completedAs.push(c.got === "failed" ? "failed" : "success");
    c.events.push(`complete:${why}`);
  };
  return {
    c,
    activity(n: ActivityNotice): void {
      state.workers.clear();
      state.cap = "idle";
      for (const a of n.agents) {
        if (a.kind === "cap") state.cap = a.state;
        else state.workers.set(a.id, a.state);
      }
      c.events.push(`activity:cap=${state.cap}`);
      complete("activity");
    },
    taskResult(): void {
      c.got = "failed";
      c.events.push("task_result");
      complete("task_result");
    },
  };
}

interface Fx {
  ws: string;
  center: ReturnType<typeof fakeCenter>;
  tracker: ReturnType<typeof createActivityTracker>;
  resumes: Array<{ capId: string; prompt: string; reason: string }>;
  fails: string[];
  /** resumeCap の戻りを解く（cap の turn が終わった）。 */
  finishTurn: () => void;
  order: string[];
  watcher: ReturnType<typeof createWorkerExitWatcher>;
  observer: RunObserver;
  logs: string[];
}

async function withFx(
  opts: { max?: number; recoverMs?: number; task?: () => string | undefined; closed?: Set<string> },
  fn: (f: Fx) => Promise<void>,
): Promise<void> {
  const ws = await mkdtemp(join(tmpdir(), "bantou-exit-test-"));
  try {
    await mkdir(join(ws, "caps", "c1"), { recursive: true });
    await mkdir(join(ws, "workers", "w1"), { recursive: true });
    const center = fakeCenter();
    const logs: string[] = [];
    const order: string[] = [];
    const tracker = createActivityTracker({
      notify: async (_c, n) => {
        order.push("activity");
        center.activity(n);
      },
      log: (m) => logs.push(m),
      intervalMs: 3_600_000,
    });
    const resumes: Fx["resumes"] = [];
    const fails: string[] = [];
    const turns: Array<() => void> = [];
    const watcher = createWorkerExitWatcher({
      workspace: ws,
      maxResumes: opts.max ?? 3,
      recoverMs: opts.recoverMs ?? 3_600_000,
      resumeCap: (capId, prompt, reason) => {
        order.push("resume");
        resumes.push({ capId, prompt, reason });
        // cap の turn: 順番待ち → 実行 → 終わり（cap の run が始まれば tracker.started が held を解く）
        return new Promise<void>((res) => {
          turns.push(() => {
            tracker.started("cap", capId, { prompt }, 1);
            tracker.finished("cap", capId, { ok: true, lost: false });
            res();
          });
        });
      },
      failTask: async (_capId, message) => {
        fails.push(message);
        await settle(); // route の送信には時間がかかる（worker の activity が先に届き得る）
        center.taskResult();
      },
      knownTask: () => (opts.task ? opts.task() : "t1"),
      taskId: async () => (opts.task ? opts.task() : "t1"),
      holdCap: (id) => tracker.holdCap(id),
      releaseCap: (id) => tracker.releaseCap(id),
      capOf: (w) => tracker.snapshot().find((a) => a.kind === "worker" && a.id === w)?.cap_id,
      ...(opts.closed ? { isClosed: (id: string) => opts.closed!.has(id) } : {}),
      log: (m) => logs.push(m),
    });
    const observer = watcher.wrap({ ...tracker, finished: (k, i, o) => { order.push("inner.finished"); tracker.finished(k, i, o); } } as RunObserver);
    await fn({ ws, center, tracker, resumes, fails, finishTurn: () => turns.shift()?.(), order, watcher, observer, logs });
    tracker.close?.();
  } finally {
    await rm(ws, { recursive: true, force: true });
  }
}

const startWorker = (f: Fx, at = T0): void => f.tracker.started("worker", "w1", { prompt: "do", capId: "c1" }, 2) ?? void at;

test("失敗で終わった worker: cap を再開し、cap が running の間は center に完了を出させない（完了は cap の turn の後に 1 回）", async () => {
  await withFx({}, async (f) => {
    startWorker(f);
    await settle();
    f.observer.finished("worker", "w1", { ok: false, lost: false, error: "boom", startedAt: T0 });
    await settle();
    assert.equal(f.resumes.length, 1);
    assert.equal(f.resumes[0]!.capId, "c1");
    assert.match(f.resumes[0]!.prompt, /^\[worker 終了通知\]\nworker_id: w1\n終わり方: failed/);
    assert.match(f.resumes[0]!.prompt, /error: boom/);
    assert.equal(f.center.c.completions, 0, `cap の turn の前に完了が出た: ${f.center.c.events.join(",")}`);
    assert.ok(f.order.indexOf("resume") < f.order.lastIndexOf("activity"), "再開を積むのは worker の終了の activity より前");
    f.finishTurn();
    await settle();
    assert.equal(f.center.c.completions, 1, f.center.c.events.join(","));
  });
});

test("再開を積むのは inner（activity の更新）より前", async () => {
  await withFx({}, async (f) => {
    startWorker(f);
    f.observer.finished("worker", "w1", { ok: false, lost: false, error: "x", startedAt: T0 });
    assert.deepEqual(f.order.slice(0, 2), ["resume", "inner.finished"]);
  });
});

test("時間切れ（maxRetries 後）・server 以外の signal・done 無しの終了も再開する。ok で done 有りと、server の停止は再開しない", async () => {
  await withFx({ max: 10 }, async (f) => {
    startWorker(f);
    f.observer.finished("worker", "w1", { ok: false, lost: false, error: "timeout", timedOut: true, startedAt: T0 });
    assert.match(f.resumes.at(-1)!.prompt, /終わり方: timeout/);
    f.observer.finished("worker", "w1", { ok: false, lost: true, error: "signal", startedAt: T0 });
    assert.match(f.resumes.at(-1)!.prompt, /終わり方: lost/);
    f.observer.finished("worker", "w1", { ok: true, lost: false, startedAt: T0 });
    assert.match(f.resumes.at(-1)!.prompt, /終わり方: no_report[\s\S]*最後の report: なし（この run の report 0 件）/);
    assert.equal(f.resumes.length, 3);
    // 停止要求・server 終了
    f.observer.finished("worker", "w1", { ok: false, lost: false, error: STOP_MSG, stopped: true, startedAt: T0 });
    f.observer.finished("worker", "w1", { ok: false, lost: false, error: "server 終了", stopped: true, startedAt: T0 });
    assert.equal(f.resumes.length, 3);
    // cap の終了は対象外
    f.observer.finished("cap", "c1", { ok: false, lost: false, error: "x" });
    assert.equal(f.resumes.length, 3);
  });
});

test("報告なし: その run の間に done があれば再開しない。前の run の done は数えない。progress だけなら再開し、件数と最後の report を渡す", async () => {
  await withFx({ max: 10 }, async (f) => {
    startWorker(f);
    f.watcher.reported("w1", "done", "2026-11-19T23:00:00.000Z"); // 前の run
    f.watcher.reported("w1", "progress", T1);
    f.observer.finished("worker", "w1", { ok: true, lost: false, startedAt: T0 });
    assert.equal(f.resumes.length, 1);
    assert.match(f.resumes[0]!.prompt, new RegExp(`最後の report: ${T1} progress（この run の report 1 件）`));
    f.watcher.reported("w1", "ask", "2026-11-20T00:15:00.000Z");
    f.observer.finished("worker", "w1", { ok: true, lost: false, startedAt: T0 });
    assert.equal(f.resumes.length, 2, "ask だけでは再開する（done のみが再開しない条件）");
    f.watcher.reported("w1", "done", "2026-11-20T00:20:00.000Z");
    f.observer.finished("worker", "w1", { ok: true, lost: false, startedAt: T0 });
    assert.equal(f.resumes.length, 2, "done があれば再開しない");
  });
});

test("再開の上限: 超えたら再開せず task の結果に error を載せる。task が変われば数え直す。center へ完了は 1 回だけ", async () => {
  let task = "t1";
  await withFx({ max: 2, task: () => task }, async (f) => {
    startWorker(f);
    for (let i = 0; i < 4; i++) f.observer.finished("worker", "w1", { ok: false, lost: false, error: `e${i}`, startedAt: T0 });
    await settle();
    assert.equal(f.resumes.length, 2, "上限 2 で再開は 2 回");
    assert.equal(f.fails.length, 2, "3・4 回目は task の結果に error");
    assert.match(f.fails[0]!, /上限（2 回）/);
    assert.match(f.fails[0]!, /error: e2/);
    assert.match(f.resumes[1]!.prompt, /この task での再開: 2\/2 回目/);
    task = "t2";
    f.observer.finished("worker", "w1", { ok: false, lost: false, error: "n", startedAt: T0 });
    assert.equal(f.resumes.length, 3, "別 task は数え直す");
  });
});

test("上限 0: 再開しない。worker の failed の activity と task_result が両方届いても center の完了は 1 回", async () => {
  await withFx({ max: 0 }, async (f) => {
    startWorker(f);
    await settle();
    f.observer.finished("worker", "w1", { ok: false, lost: false, error: "x", startedAt: T0 });
    await settle();
    assert.equal(f.resumes.length, 0);
    assert.equal(f.fails.length, 1);
    assert.equal(f.center.c.completions, 1, f.center.c.events.join(","));
    assert.deepEqual(f.center.c.completedAs, ["failed"], `完了が成功扱いで先に届いた: ${f.center.c.events.join(",")}`);
  });
});

test("再開の輪: 再開された cap が worker を起こして失敗し続けても、上限で止まる", async () => {
  await withFx({ max: 3 }, async (f) => {
    startWorker(f);
    for (let round = 0; round < 8; round++) {
      f.observer.finished("worker", "w1", { ok: false, lost: false, error: "again", startedAt: T0 });
      f.finishTurn();
      await settle();
    }
    assert.equal(f.resumes.length, 3);
    assert.equal(f.fails.length, 5);
    assert.equal(f.center.c.completions, 1, f.center.c.events.join(","));
  });
});

test("再起動: 保存してある状態から、報告なしで終わった worker を 1 回だけ拾う。done 有り・停止・古い物・通知済みは拾わない", async () => {
  await withFx({}, async (f) => {
    const mk = async (id: string, st: Partial<Parameters<typeof writeState>[1]>) => {
      await mkdir(agentDir(f.ws, "worker", id), { recursive: true });
      await writeOwner(f.ws, id, "c1");
      await writeState(agentDir(f.ws, "worker", id), {
        session_id: "s", state: "idle", last_started_at: new Date(Date.now() - 120_000).toISOString(), last_finished_at: new Date(Date.now() - 60_000).toISOString(), retries: 0, ...st,
      });
    };
    await writeState(agentDir(f.ws, "cap", "c1"), { session_id: "cs", state: "idle", last_started_at: null, last_finished_at: null, retries: 0 });
    await mk("w1", {}); // 報告なしで idle → 拾う
    await mk("w2", {}); // done が reports にある
    await mk("w3", { state: "failed", last_error: STOP_MSG }); // 停止
    await mk("w4", { last_finished_at: new Date(Date.now() - 7_200_000).toISOString() }); // 古い
    await mk("w5", { state: "failed", last_error: "boom" }); // 失敗 → 拾う
    await mkdir(join(f.ws, "caps", "c1", "logs"), { recursive: true });
    const startedAfter = new Date(Date.now() - 100_000).toISOString();
    await writeFile(join(f.ws, "caps", "c1", "logs", "reports.jsonl"), JSON.stringify({ at: startedAfter, worker_id: "w2", kind: "done" }) + "\n");
    assert.equal(await f.watcher.recover(), 2);
    assert.deepEqual(f.resumes.map((r) => /worker_id: (\w+)/.exec(r.prompt)![1]).sort(), ["w1", "w5"]);
    await settle();
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(await f.watcher.recover(), 0, "2 回目は拾わない（通知済みの印）");
  });
});

test("CAP_GUIDE に [worker 終了通知] を受けた時の動きがあり、prompt の先頭行と一致する", () => {
  assert.ok(CAP_GUIDE.includes("[worker 終了通知]"));
  assert.ok(buildExitPrompt({ worker_id: "w1", cause: "failed", report_count: 0 }, 1, 3).startsWith("[worker 終了通知]\n"));
});

test("閉じた cap: worker が kill（lost）・失敗で終わっても cap を再開しない。再起動後の回収でも拾わない", async () => {
  const closed = new Set(["c1"]);
  await withFx({ closed }, async (f) => {
    startWorker(f);
    await settle();
    f.observer.finished("worker", "w1", { ok: false, lost: true, error: "signal SIGKILL で終了（server からの停止ではない）", startedAt: T0 });
    f.observer.finished("worker", "w1", { ok: false, lost: false, error: "boom", startedAt: T1 });
    await settle();
    assert.equal(f.resumes.length, 0);
    assert.ok(f.logs.some((l) => l.includes("閉じた cap の worker の終了は再開しない")));
    // 再起動後の回収: cap に会話が残っていても（旧版で起き直していた等）、閉じた印があれば拾わない
    await writeState(agentDir(f.ws, "cap", "c1"), { session_id: "cs", state: "idle", last_started_at: null, last_finished_at: null, retries: 0 });
    await mkdir(agentDir(f.ws, "worker", "w9"), { recursive: true });
    await writeOwner(f.ws, "w9", "c1");
    await writeState(agentDir(f.ws, "worker", "w9"), {
      session_id: "s", state: "failed", last_error: "前回の実行が終了しないまま server が落ちた",
      last_started_at: new Date(Date.now() - 120_000).toISOString(), last_finished_at: new Date(Date.now() - 60_000).toISOString(), retries: 0,
    });
    assert.equal(await f.watcher.recover(), 0);
    assert.equal(f.resumes.length, 0);
    // 印が外れた（center が次の task を送った）後でも、済みにした終了は拾わない
    closed.clear();
    assert.equal(await f.watcher.recover(), 0);
  });
});
