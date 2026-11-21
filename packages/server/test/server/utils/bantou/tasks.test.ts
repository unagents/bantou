import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerNotice, ServerReply, StatusReply, TaskCommand, TaskResultReply, WorkerReportNotice } from "@agent-hand/bantou-protocol";
import { STOP_MSG, createAgentManager, type AgentManager } from "../../../../server/utils/bantou/agents";
import type { ClaudeRunOptions, ClaudeRunResult } from "../../../../server/utils/bantou/claude";
import { DEFAULT_SESSION, type Config } from "../../../../server/utils/bantou/config";
import { execute } from "../../../../server/utils/bantou/daemon";
import { createReportHub, type ReportHub } from "../../../../server/utils/bantou/reports";
import { readState } from "../../../../server/utils/bantou/state";
import { createTaskScheduler, type TaskScheduler } from "../../../../server/utils/bantou/tasks";
import { createWorkerHub, readOwnerRecord, type WorkerHub } from "../../../../server/utils/bantou/workers";
import { laneDir } from "../../../../server/utils/bantou/paths";
import { taskInvokeInput } from "../../../../server/utils/bantou/daemon";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function until(what: string, pred: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error(`タイムアウト: ${what}`);
    await sleep(10);
  }
}

/** 決めた時間内に解けなければ失敗にする（止まらない不具合でテストが止まり続けないように）。 */
const within = <T>(p: Promise<T>, what: string, ms = 3000): Promise<T> =>
  Promise.race([p, sleep(ms).then((): never => {
    throw new Error(`タイムアウト: ${what}`);
  })]);

const ok = (text: string): ClaudeRunResult => ({ ok: true, sessionId: "x", resultText: text, durationMs: 1 });
const ng = (detail: string, signal: NodeJS.Signals | null = null): ClaudeRunResult => ({ ok: false, sessionMissing: false, timedOut: false, detail, durationMs: 1, signal });

/** runner の 1 回の呼び出し。release で結果を返す。kill されると signal 終了で返る。 */
interface Call {
  o: ClaudeRunOptions;
  /** cap の task の lane（logFile の置き場から）。worker や cap の本体は undefined。 */
  lane: string | undefined;
  release: (r?: ClaudeRunResult) => void;
  killed: string[];
  done: boolean;
}

const laneOfCall = (o: ClaudeRunOptions): string | undefined => /\/logs\/tasks\/([^/]+)\/logs\//.exec(o.logFile ?? "")?.[1];

interface Sys {
  ws: string;
  manager: AgentManager;
  scheduler: TaskScheduler;
  hub: ReportHub;
  workers: WorkerHub;
  calls: Call[];
  /** center へ送った report 起因の返信・通知。 */
  sent: Array<ServerReply | ServerNotice>;
  logs: string[];
  /** task を送る（daemon と同じく、返信を作った後に replied を呼ぶ）。 */
  send: (cmd: TaskCommand) => Promise<ServerReply>;
  status: () => Promise<StatusReply>;
  call: (pred: (c: Call) => boolean) => Call | undefined;
}

const task = (taskId: string, branch?: string, capId = "c1"): TaskCommand => ({
  bantou: 1,
  type: "task",
  cap_id: capId,
  task_id: taskId,
  goal: `goal of ${taskId}`,
  deliverables: branch !== undefined ? { branch } : {},
  verify: {},
  constraints: [],
  workers: {},
});

async function withSystem(maxParallel: number, fn: (s: Sys) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "bantou-tasks-test-"));
  const calls: Call[] = [];
  try {
    const ws = join(dir, "ws");
    await mkdir(join(ws, "caps", "c1"), { recursive: true });
    await mkdir(join(ws, "workers"), { recursive: true });
    const config: Config = {
      workspace: ws,
      broker: { port: 0, bind: "127.0.0.1", discovery: "off", token: "" },
      mcp: { port: 0, bind: "127.0.0.1" },
      session: { ...structuredClone(DEFAULT_SESSION), maxRetries: 0, maxParallelTasks: maxParallel },
      update: { spec: "bantou@{version}" },
    };
    const logs: string[] = [];
    const sent: Array<ServerReply | ServerNotice> = [];
    const log = (m: string): void => void logs.push(m);
    const runner = {
      run: (o: ClaudeRunOptions): Promise<ClaudeRunResult> =>
        new Promise<ClaudeRunResult>((resolve) => {
          const killed: string[] = [];
          const handlers: Array<() => void> = [];
          const c: Call = {
            o,
            lane: laneOfCall(o),
            killed,
            done: false,
            release: (r = ok(`done ${laneOfCall(o) ?? o.prompt}`)) => {
              if (c.done) return;
              c.done = true;
              resolve(r);
            },
          };
          const child = {
            pid: undefined,
            exitCode: null as number | null,
            signalCode: null as string | null,
            kill: (sig: string) => {
              killed.push(sig);
              child.signalCode = sig;
              for (const h of handlers.splice(0)) h();
              c.release(ng(`signal ${sig}`, sig as NodeJS.Signals));
              return true;
            },
            once: (_ev: string, h: () => void) => void handlers.push(h),
          };
          o.onSpawn?.(child as never);
          calls.push(c);
        }),
    };
    let scheduler!: TaskScheduler;
    let hub!: ReportHub;
    // daemon と同じ配線（run の追加・終わりで task の状態を追う）
    const manager = createAgentManager({
      config,
      runner,
      log,
      stopGraceMs: 50,
      onRunAdded: (run) => {
        if (run.taskId !== undefined && run.capId !== undefined) scheduler.touch(run.capId, run.taskId);
      },
      onRunSettled: (run, result) => {
        if (run.kind === "cap" && run.taskId !== undefined) scheduler.noteOutcome(run.id, run.taskId, result);
        scheduler.check();
      },
    });
    hub = createReportHub({
      workspace: ws,
      invoke: (capId, input) => manager.invoke("cap", capId, input),
      send: async (_to, r) => void sent.push(r),
      laneOf: async (capId, workerId) => {
        const o = await readOwnerRecord(ws, workerId);
        return o?.capId === capId ? o.taskId : undefined;
      },
      onLaneSettled: () => scheduler.check(),
      log,
    });
    scheduler = createTaskScheduler({
      maxParallel,
      run: (cmd) => manager.invoke("cap", cmd.cap_id, taskInvokeInput(cmd)),
      busy: (capId, taskId) => manager.laneBusy(capId, taskId) || hub.pendingFor(capId, taskId) > 0,
      log,
    });
    const workers = createWorkerHub({ workspace: ws, manager, activity: { snapshot: () => [] }, log, taskActive: (c, t) => scheduler.isActive(c, t) });
    await hub.rememberCenter("c1", "center-1");
    const send = async (cmd: TaskCommand): Promise<ServerReply> => {
      const r = await execute(cmd, manager, workers, undefined, scheduler);
      scheduler.replied(cmd.cap_id, cmd.task_id);
      return r;
    };
    const status = async (): Promise<StatusReply> => (await execute({ bantou: 1, type: "status" }, manager, workers, undefined, scheduler)) as StatusReply;
    await fn({ ws, manager, scheduler, hub, workers, calls, sent, logs, send, status, call: (pred) => calls.find(pred) });
    for (const c of calls) c.release();
    await manager.shutdown();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const laneCall = (s: Sys, t: string): Call | undefined => s.call((c) => c.lane === t);
const tasksOf = (s: Sys): Record<string, string> => Object.fromEntries(s.scheduler.snapshot("c1").map((t) => [t.task_id, t.state + (t.waiting_for ? `(${t.waiting_for})` : "")]));

test("tasks: 別 branch の 2 task は同時に動く（task ごとに別の指揮の会話、cwd は cap の dir）", async () => {
  await withSystem(2, async (s) => {
    const p1 = s.send(task("t-1", "feat/a"));
    const p2 = s.send(task("t-2", "feat/b"));
    // どちらも release する前に指揮の run が始まっている = 並行
    await until("2 つの指揮が走る", () => laneCall(s, "t-1") !== undefined && laneCall(s, "t-2") !== undefined);
    const c1 = laneCall(s, "t-1")!;
    const c2 = laneCall(s, "t-2")!;
    assert.equal(c1.o.cwd, join(s.ws, "caps", "c1"));
    assert.equal(c2.o.cwd, join(s.ws, "caps", "c1"));
    assert.notEqual(c1.o.sessionId, c2.o.sessionId);
    assert.ok(c1.o.prompt.startsWith("[task t-1]\n"));
    assert.ok(c2.o.prompt.startsWith("[task t-2]\n"));
    assert.deepEqual(tasksOf(s), { "t-1": "running", "t-2": "running" });
    // status の cap は running で、tasks に両方
    const cap = (await s.status()).caps.find((c) => c.id === "c1")!;
    assert.equal(cap.state, "running");
    assert.deepEqual(cap.tasks?.map((t) => [t.task_id, t.state, t.branch]), [["t-1", "running", "feat/a"], ["t-2", "running", "feat/b"]]);
    assert.equal((await readState(laneDir(s.ws, "c1", "t-1"))).state, "running");
    c2.release();
    const r2 = (await p2) as TaskResultReply;
    assert.equal(r2.type, "task_result");
    assert.equal(r2.task_id, "t-2");
    await until("t-2 が終わる", () => tasksOf(s)["t-2"] === "done");
    assert.equal(tasksOf(s)["t-1"], "running");
    c1.release();
    assert.equal(((await p1) as TaskResultReply).task_id, "t-1");
    await until("t-1 が終わる", () => tasksOf(s)["t-1"] === "done");
  });
});

test("tasks: 同じ branch の 2 task は順に動く（前の task の worker が終わるまで後の task は始まらない）", async () => {
  await withSystem(2, async (s) => {
    const p1 = s.send(task("t-1", "feat/x"));
    await until("t-1 の指揮", () => laneCall(s, "t-1") !== undefined);
    // t-1 の指揮が worker を起動する（mcp の x-bantou-task-id = t-1）
    const w = await s.workers.start("c1", { prompt: "implement" }, "t-1");
    await until("worker の run", () => s.call((c) => c.lane === undefined && c.o.prompt === "implement") !== undefined);
    assert.deepEqual(await readOwnerRecord(s.ws, w.worker_id), { capId: "c1", taskId: "t-1" });
    const p2 = s.send(task("t-2", "feat/x"));
    await sleep(50);
    assert.equal(laneCall(s, "t-2"), undefined, "同じ branch の t-2 は待つ");
    assert.deepEqual(tasksOf(s), { "t-1": "running", "t-2": "waiting(branch)" });
    // t-1 の指揮の turn が終わっても、t-1 の worker が動いている間は t-1 は終わらない
    laneCall(s, "t-1")!.release();
    assert.equal(((await p1) as TaskResultReply).task_id, "t-1");
    await sleep(50);
    assert.equal(laneCall(s, "t-2"), undefined, "t-1 の worker が動いている間は始まらない");
    assert.equal(tasksOf(s)["t-1"], "running");
    // worker が終わる → t-1 が終わる → t-2 が始まる
    s.call((c) => c.o.prompt === "implement")!.release();
    await until("t-2 の指揮が始まる", () => laneCall(s, "t-2") !== undefined);
    assert.equal(tasksOf(s)["t-1"], "done");
    assert.equal(tasksOf(s)["t-2"], "running");
    laneCall(s, "t-2")!.release();
    assert.equal(((await p2) as TaskResultReply).task_id, "t-2");
  });
});

test("tasks: 上限（maxParallelTasks）を越えた分は待ち、前の task が終わったら始まる。branch の無い task は上限の内で並行", async () => {
  await withSystem(2, async (s) => {
    const ps = ["t-1", "t-2", "t-3"].map((t) => s.send(task(t)));
    await until("2 つ走る", () => s.calls.length === 2);
    await sleep(50);
    assert.equal(s.calls.length, 2, "3 つ目は上限で待つ");
    assert.deepEqual(tasksOf(s), { "t-1": "running", "t-2": "running", "t-3": "waiting(limit)" });
    // status: 待っている task は queued に数える
    const cap = (await s.status()).caps.find((c) => c.id === "c1")!;
    assert.equal(cap.queued, 1);
    assert.equal(cap.tasks?.find((t) => t.task_id === "t-3")?.waiting_for, "limit");
    laneCall(s, "t-1")!.release();
    await until("t-3 が始まる", () => laneCall(s, "t-3") !== undefined);
    assert.equal(laneCall(s, "t-2")!.done, false);
    laneCall(s, "t-2")!.release();
    laneCall(s, "t-3")!.release();
    const rs = (await Promise.all(ps)) as TaskResultReply[];
    assert.deepEqual(rs.map((r) => r.task_id), ["t-1", "t-2", "t-3"]);
  });
});

test("tasks: 上限 1 は従来どおり 1 つずつ", async () => {
  await withSystem(1, async (s) => {
    const p1 = s.send(task("t-1"));
    const p2 = s.send(task("t-2"));
    await until("t-1", () => laneCall(s, "t-1") !== undefined);
    await sleep(50);
    assert.equal(laneCall(s, "t-2"), undefined);
    laneCall(s, "t-1")!.release();
    await p1;
    await until("t-2", () => laneCall(s, "t-2") !== undefined);
    laneCall(s, "t-2")!.release();
    await p2;
  });
});

test("tasks: 片方の task の失敗は他方を止めない", async () => {
  await withSystem(2, async (s) => {
    const p1 = s.send(task("t-1", "feat/a"));
    const p2 = s.send(task("t-2", "feat/b"));
    await until("2 つ走る", () => laneCall(s, "t-1") !== undefined && laneCall(s, "t-2") !== undefined);
    laneCall(s, "t-1")!.release(ng("終了コード 1"));
    const r1 = (await p1) as TaskResultReply;
    assert.equal(r1.state, "failed");
    assert.equal(r1.error, "終了コード 1");
    await until("t-1 が failed", () => tasksOf(s)["t-1"] === "failed");
    // t-2 は止まらず走り続け、成功で終わる
    assert.equal(laneCall(s, "t-2")!.done, false);
    assert.deepEqual(laneCall(s, "t-2")!.killed, []);
    assert.equal(tasksOf(s)["t-2"], "running");
    laneCall(s, "t-2")!.release();
    const r2 = (await p2) as TaskResultReply;
    assert.equal(r2.state, "done");
    await until("t-2 が done", () => tasksOf(s)["t-2"] === "done");
    assert.equal(s.scheduler.snapshot("c1").find((t) => t.task_id === "t-1")?.error, "終了コード 1");
  });
});

test("tasks: stop_cap（remote_delete）は動いている task の指揮・worker と待っている task を全部止め、lane の会話も破棄する", async () => {
  await withSystem(2, async (s) => {
    const p1 = s.send(task("t-1", "feat/a"));
    const p2 = s.send(task("t-2", "feat/b"));
    const p3 = s.send(task("t-3", "feat/c"));
    await until("2 つ走る", () => laneCall(s, "t-1") !== undefined && laneCall(s, "t-2") !== undefined);
    await s.workers.start("c1", { prompt: "w of t-1" }, "t-1");
    await until("worker", () => s.call((c) => c.o.prompt === "w of t-1") !== undefined);
    assert.equal(tasksOf(s)["t-3"], "waiting(limit)");
    const lane1 = laneDir(s.ws, "c1", "t-1");
    const before = (await readState(lane1)).session_id;
    assert.ok(before);
    const stop = await execute({ bantou: 1, type: "stop_cap", cap_id: "c1" }, s.manager, s.workers, undefined, s.scheduler);
    assert.equal(stop.type, "stop_result");
    assert.equal((stop as { stopped: boolean }).stopped, true);
    assert.equal((stop as { workers_stopped: number }).workers_stopped, 1);
    assert.equal((stop as { session_cleared: boolean }).session_cleared, true);
    for (const [i, p] of [p1, p2, p3].entries()) {
      const r = (await within(p, `t-${i + 1} の返信`)) as TaskResultReply;
      assert.equal(r.state, "failed");
      assert.equal(r.error, STOP_MSG);
    }
    assert.deepEqual(laneCall(s, "t-1")!.killed, ["SIGTERM"]);
    assert.deepEqual(laneCall(s, "t-2")!.killed, ["SIGTERM"]);
    assert.deepEqual(s.call((c) => c.o.prompt === "w of t-1")!.killed, ["SIGTERM"]);
    assert.equal(laneCall(s, "t-3"), undefined, "待っていた task は始まらない");
    await until("全部 failed", () => Object.values(tasksOf(s)).every((x) => x === "failed"));
    assert.equal((await readState(lane1)).session_id, null);
    assert.equal(s.manager.isActive("cap", "c1"), false);
    // 閉じた後の新しい task は普通に動く
    const p4 = s.send(task("t-4", "feat/a"));
    await until("t-4", () => laneCall(s, "t-4") !== undefined);
    laneCall(s, "t-4")!.release();
    assert.equal(((await p4) as TaskResultReply).state, "done");
  });
});

test("tasks: worker_report の task_id はその worker を起動した task。report は同じ task の指揮を再開し、返信はその task の task_result", async () => {
  await withSystem(2, async (s) => {
    const p1 = s.send(task("t-1", "feat/a"));
    const p2 = s.send(task("t-2", "feat/b"));
    await until("2 つ走る", () => laneCall(s, "t-1") !== undefined && laneCall(s, "t-2") !== undefined);
    const wa = await s.workers.start("c1", { prompt: "wa" }, "t-1");
    const wb = await s.workers.start("c1", { prompt: "wb" }, "t-2");
    // 別の task（動いている）の worker は触れない
    await assert.rejects(s.workers.start("c1", { worker_id: wa.worker_id, prompt: "x" }, "t-2"), /別の task（t-1）の worker/);
    await assert.rejects(s.workers.stop("c1", wb.worker_id, "t-1"), /別の task（t-2）の worker/);
    laneCall(s, "t-1")!.release();
    laneCall(s, "t-2")!.release();
    await Promise.all([p1, p2]);
    // t-2 の worker が先に report。最新の task（t-2）でなく、起動した task で数える
    await s.hub.report("c1", wa.worker_id, "done", "a finished");
    await s.hub.report("c1", wb.worker_id, "done", "b finished");
    const notices = (): WorkerReportNotice[] => s.sent.filter((x): x is WorkerReportNotice => x.type === "worker_report");
    await until("2 通の worker_report", () => notices().length === 2);
    assert.deepEqual(notices().map((n) => [n.worker_id, n.task_id]).sort(), [[wa.worker_id, "t-1"], [wb.worker_id, "t-2"]].sort());
    // 再開は各 task の指揮（lane）。2 回目の指揮の run（resume）
    await until("2 つの再開", () => s.calls.filter((c) => c.lane !== undefined && c.o.mode === "resume").length === 2);
    const resumes = s.calls.filter((c) => c.lane !== undefined && c.o.mode === "resume");
    assert.deepEqual(resumes.map((c) => [c.lane, c.o.prompt.split(" ")[1]]).sort(), [["t-1", wa.worker_id], ["t-2", wb.worker_id]]);
    for (const c of resumes) c.release(ok(`{"summary":"final of ${c.lane}"}`));
    await s.hub.drain();
    const results = s.sent.filter((x): x is TaskResultReply => x.type === "task_result");
    assert.deepEqual(results.map((r) => [r.task_id, r.summary]).sort(), [["t-1", "final of t-1"], ["t-2", "final of t-2"]]);
    // worker の run も終わると、両方の task が終わる
    s.call((c) => c.o.prompt === "wa")!.release();
    s.call((c) => c.o.prompt === "wb")!.release();
    await until("両方 done", () => tasksOf(s)["t-1"] === "done" && tasksOf(s)["t-2"] === "done");
  });
});

test("tasks: 返信を送り終えるまで task は終わらない。同じ task_id の重複は断る", async () => {
  await withSystem(2, async (s) => {
    const p = execute(task("t-1"), s.manager, s.workers, undefined, s.scheduler);
    await until("t-1", () => laneCall(s, "t-1") !== undefined);
    const dup = await execute(task("t-1"), s.manager, s.workers, undefined, s.scheduler);
    assert.equal(dup.type, "error");
    assert.match((dup as { message: string }).message, /同じ task_id/);
    laneCall(s, "t-1")!.release();
    await p;
    await sleep(50);
    assert.equal(tasksOf(s)["t-1"], "running", "replied の前は終わらない");
    assert.deepEqual(s.scheduler.waitRuns().map((r) => [r.taskId, r.phase]), [["t-1", "preparing"]]);
    s.scheduler.replied("c1", "t-1");
    await until("done", () => tasksOf(s)["t-1"] === "done");
    assert.deepEqual(s.scheduler.waitRuns(), []);
  });
});
