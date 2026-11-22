import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import type { CapTaskInfo } from "@agent-hand/bantou-protocol";
import { createActivityStore } from "../src/activity.js";
import { createRemoteManager, type RemoteRecord } from "../src/remotes.js";
import type { ServerLink, ServerPeer } from "../src/server-link.js";
import { createJsonListStore } from "../src/store.js";
import { buildTaskStatus } from "../src/task-status.js";

// server が同じ cap の task を並行に動かす（status / activity の cap に tasks を載せる）時の center の扱い

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "center-par-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
});

const CENTER = "c-0123456789";
const CAP = `${CENTER}-pm1`;
const peerA: ServerPeer = { id: "id-a", name: "bantou-server", hostname: "host-a", version: "1.1.0" };
const tick = (ms = 10): Promise<void> => new Promise((r) => setTimeout(r, ms));
const at = "2026-11-21T00:00:00.000Z";
async function until(what: string, pred: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error(`タイムアウト: ${what}`);
    await tick(5);
  }
}

const info = (task_id: string, state: CapTaskInfo["state"], extra: Partial<CapTaskInfo> = {}): CapTaskInfo => ({
  task_id,
  state,
  queued_at: at,
  started_at: state === "waiting" ? null : at,
  finished_at: state === "done" || state === "failed" ? at : null,
  ...extra,
});

const taskResult = (taskId: string, summary: string, state: "done" | "failed" = "done") => ({
  bantou: 1, type: "task_result", cap_id: CAP, task_id: taskId, state, summary,
  workers: [], review: { verdict: "unknown", items: [], rounds: 0 }, remaining: [], ...(state === "failed" ? { error: "boom" } : {}),
});

function setup() {
  const kicks: { cmd: Record<string, unknown>; resolve: (r: unknown) => void }[] = [];
  /** server の cap の状態。status は毎回これを返す（tasks を載せる新しい server）。cap の負荷・last_started_at は変えない（tasks だけで受付を確かめられること）。 */
  const server = { exists: false, state: "running", tasks: [] as CapTaskInfo[] };
  const link = {
    peers: async () => [peerA],
    selectPeer: async () => peerA,
    statusOn: async () => ({
      bantou: 1,
      type: "status_result",
      ok: true,
      caps: server.exists ? [{ kind: "cap", id: CAP, path: "/w", session_id: "s", state: server.state, last_started_at: "s0", last_finished_at: null, retries: 0, queued: 0, tasks: server.tasks }] : [],
      workers: [],
    }),
    taskOn: (_peer: ServerPeer, cmd: Record<string, unknown>, hooks?: { onSent?: () => void }) =>
      new Promise((resolve) => {
        kicks.push({ cmd, resolve });
        hooks?.onSent?.();
      }),
  } as unknown as ServerLink;
  const activity = createActivityStore();
  const sent: { owner: string; text: string }[] = [];
  const store = createJsonListStore<RemoteRecord>(join(dir, "remotes.json"), () => {});
  const mgr = createRemoteManager({
    link, store, log: () => {}, capId: CENTER, graceMs: 60, pollMs: 40, ackTimeoutMs: 300, ackPollMs: 10, reachCheckMs: 0, activity,
    notify: async (owner, text) => {
      sent.push({ owner, text });
      return { ok: true };
    },
  });
  /** server の activity（cap の agent に tasks、worker は任意）を届ける。 */
  const pushActivity = (capState: string, tasks: CapTaskInfo[], workers: Array<{ id: string; state: string; task_id?: string }> = []): void => {
    activity.apply({
      bantou: 1, type: "activity", cap_id: CAP, at,
      agents: [
        { kind: "cap", id: CAP, cap_id: CAP, state: capState as never, task: "t", last_activity: null, last_output_at: null, silent_ms: 0, started_at: at, finished_at: null, tasks },
        ...workers.map((w) => ({ kind: "worker" as const, id: w.id, cap_id: CAP, state: w.state as never, task: "w", last_activity: null, last_output_at: null, silent_ms: 0, started_at: at, finished_at: null, ...(w.task_id ? { task_id: w.task_id } : {}) })),
      ],
    }, peerA.id);
    mgr.onActivity(CAP, peerA.id);
  };
  return { mgr, kicks, server, sent, pushActivity };
}

test("並行 task: 受付は status の cap の tasks に task_id が載ったかで確かめる（cap の負荷が変わらなくても受付、載らなければ未確認）", async () => {
  const s = setup();
  s.server.exists = true;
  // 1 つ目: server が tasks に載せる（cap は送る前から running・queued 0 のまま）
  const p1 = s.mgr.send({ owner: "pm1", goal: "one" });
  await until("kick 1", () => s.kicks.length === 1);
  const id1 = s.kicks[0]!.cmd.task_id as string;
  s.server.tasks = [info(id1, "running")];
  const r1 = await p1;
  assert.equal(r1.delivered, true);
  assert.equal(r1.delivery_basis, "status");
  // 2 つ目: tasks に載らない間は、cap が running でも受付にしない（旧来の負荷の比較に頼らない）
  const r2 = await s.mgr.send({ owner: "pm1", goal: "two" });
  assert.equal(r2.delivered, false);
  assert.equal(r2.delivery, "sent");
});

test("並行 task: 終わった task は task ごとに完了にして通知する（他の task が動いていても待たない）。task_status にはまだ動いている task だけが残る", async () => {
  const s = setup();
  s.server.exists = true;
  const p1 = s.mgr.send({ owner: "pm1", goal: "first goal", deliverables: { branch: "feat/a" } });
  await until("kick 1", () => s.kicks.length === 1);
  const t1 = s.kicks[0]!.cmd.task_id as string;
  s.server.tasks = [info(t1, "running", { branch: "feat/a" })];
  await p1;
  const p2 = s.mgr.send({ owner: "pm1", goal: "second goal", deliverables: { branch: "feat/b" } });
  await until("kick 2", () => s.kicks.length === 2);
  const t2 = s.kicks[1]!.cmd.task_id as string;
  s.server.tasks = [info(t1, "running", { branch: "feat/a" }), info(t2, "running", { branch: "feat/b" })];
  await p2;
  // 両方の最初の返信（指揮の最初の turn）
  s.kicks[0]!.resolve(taskResult(t1, "workers started"));
  s.kicks[1]!.resolve(taskResult(t2, "workers started"));
  await tick();
  // t1 の最終の返答（report 起因の再開の task_result）が届き、その後 server が t1 を done と知らせる。t2 の worker はまだ動いている
  assert.equal(s.mgr.applyLateReply(taskResult(t1, "t1 final") as never, peerA.id), true);
  s.pushActivity("running", [info(t1, "done", { branch: "feat/a" }), info(t2, "running", { branch: "feat/b" })], [{ id: "w-b", state: "running", task_id: t2 }]);
  await tick();
  const v = s.mgr.list({ owner: "pm1" })[0]!;
  assert.equal(v.state, "running", "cap 全体は t2 が動いているので running");
  assert.deepEqual(v.pending.map((p) => p.task_id), [t2]);
  assert.deepEqual(v.pending[0]!.server_task, { state: "running", branch: "feat/b" });
  const done1 = s.sent.filter((x) => x.text.startsWith("[bantou] remote 完了"));
  assert.equal(done1.length, 1);
  assert.match(done1[0]!.text, new RegExp(`task_id=${t1} state=done`));
  assert.match(done1[0]!.text, /result: t1 final/);
  assert.match(done1[0]!.text, /指示: first goal/);
  const ts = buildTaskStatus(s.mgr.list({ owner: "pm1" }), "pm1", Date.now());
  assert.deepEqual(ts.tasks.map((t) => t.task_id), [t2]);
  assert.match(ts.tasks[0]!.line, /\| 実行中 \|/);
  // t2 が失敗で終わる → t2 も完了（failed）として通知。cap 全体も終わる
  assert.equal(s.mgr.applyLateReply(taskResult(t2, "t2 broke", "failed") as never, peerA.id), true);
  s.pushActivity("idle", [info(t1, "done"), info(t2, "failed", { error: "終了コード 1" })]);
  await tick();
  const done2 = s.sent.filter((x) => x.text.startsWith("[bantou] remote 完了"));
  assert.equal(done2.length, 2);
  assert.match(done2[1]!.text, new RegExp(`task_id=${t2} state=failed`));
  assert.match(done2[1]!.text, /error: 終了コード 1/);
  const after = s.mgr.list({ owner: "pm1" })[0]!;
  assert.deepEqual(after.pending, []);
  assert.notEqual(after.state, "running");
});

test("並行 task: 最初の返信（task_result）を受ける前は、server が done と知らせても完了にしない", async () => {
  const s = setup();
  s.server.exists = true;
  const p1 = s.mgr.send({ owner: "pm1", goal: "one" });
  await until("kick 1", () => s.kicks.length === 1);
  const t1 = s.kicks[0]!.cmd.task_id as string;
  s.server.tasks = [info(t1, "running")];
  await p1;
  s.pushActivity("idle", [info(t1, "done")]);
  await tick();
  assert.deepEqual(s.mgr.list({ owner: "pm1" })[0]!.pending.map((p) => p.task_id), [t1]);
  assert.equal(s.sent.filter((x) => x.text.startsWith("[bantou] remote 完了")).length, 0);
  s.kicks[0]!.resolve(taskResult(t1, "answer"));
  await tick();
  assert.deepEqual(s.mgr.list({ owner: "pm1" })[0]!.pending, []);
  const done = s.sent.filter((x) => x.text.startsWith("[bantou] remote 完了"));
  assert.equal(done.length, 1);
  assert.match(done[0]!.text, new RegExp(`task_id=${t1} state=done`));
});

test("並行 task: 待っている task は task_status で待ちの理由を出す（同じ branch / 上限）", async () => {
  const s = setup();
  s.server.exists = true;
  const ids: string[] = [];
  for (const [i, goal] of ["a", "b", "c"].entries()) {
    const p = s.mgr.send({ owner: "pm1", goal, deliverables: { branch: i === 2 ? "feat/x" : `feat/${goal}` } });
    await until(`kick ${i + 1}`, () => s.kicks.length === i + 1);
    ids.push(s.kicks[i]!.cmd.task_id as string);
    s.server.tasks = ids.map((id, j) => (j < 2 ? info(id, "running") : info(id, "waiting", { waiting_for: "branch", branch: "feat/x" })));
    await p;
  }
  s.pushActivity("running", [info(ids[0]!, "running"), info(ids[1]!, "waiting", { waiting_for: "limit" }), info(ids[2]!, "waiting", { waiting_for: "branch", branch: "feat/x" })]);
  await tick();
  const lines = buildTaskStatus(s.mgr.list({ owner: "pm1" }), "pm1", Date.now()).tasks.map((t) => t.line);
  assert.match(lines[0]!, /\| 実行中 \|/);
  assert.match(lines[1]!, /\| 待ち（利用者が置いた並行の上限） \|/);
  assert.match(lines[2]!, /\| 待ち（同じ branch feat\/x の前の task。旧 server） \|/);
});

test("並行 task: 同じ branch の task は待たず、task_status に同じ branch の task の数が出る", async () => {
  const s = setup();
  s.server.exists = true;
  const p = s.mgr.send({ owner: "pm1", goal: "a", deliverables: { branch: "feat/x" } });
  await until("kick 1", () => s.kicks.length === 1);
  const id = s.kicks[0]!.cmd.task_id as string;
  s.server.tasks = [info(id, "running", { same_branch: ["t-other"], branch: "feat/x" })];
  await p;
  s.pushActivity("running", [info(id, "running", { same_branch: ["t-other"], branch: "feat/x" })]);
  await tick();
  const lines = buildTaskStatus(s.mgr.list({ owner: "pm1" }), "pm1", Date.now()).tasks.map((t) => t.line);
  assert.match(lines[0]!, /実行中（同じ branch の task 1 本）/);
});
