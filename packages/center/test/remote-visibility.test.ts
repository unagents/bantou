import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { createActivityStore } from "../src/activity.js";
import { createRemoteManager, type RemoteRecord } from "../src/remotes.js";
import type { ServerLink, ServerPeer } from "../src/server-link.js";
import { createJsonListStore } from "../src/store.js";
import { registerSessionTools } from "../src/tools.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "center-vis-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
});

const CENTER = "c-0123456789";
const CAP = `${CENTER}-pm1`;
const peerA: ServerPeer = { id: "id-a", name: "bantou-server", hostname: "host-a", version: "1.1.0" };
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const tick = (): Promise<void> => sleep(10);

/** fake の server link。server は task を受けると cap の last_started_at を進める（accept=false なら受け付けない = 届かない）。down=true は無返信。 */
function setup(extra: Partial<Parameters<typeof createRemoteManager>[0]> = {}) {
  const st = { accept: true, down: false, started: 0, taskCalls: 0, statusCalls: 0, capExists: false, notifyLost: false };
  const activity = createActivityStore();
  const changes: string[] = [];
  const link = {
    peers: async () => [peerA],
    identifiedPeers: async () => [peerA],
    selectPeer: async () => peerA,
    statusOn: async () => {
      st.statusCalls++;
      if (st.down) return { bantou: 1, type: "error", ok: false, message: "返信が来ない（status）", transport: true } as never;
      return {
        bantou: 1, type: "status_result", ok: true, workers: [],
        caps: st.capExists ? [{ kind: "cap", id: CAP, state: "idle", queued: 0, last_started_at: st.started === 0 ? null : `s${st.started}` }] : [],
      } as never;
    },
    taskOn: (_p: ServerPeer, _c: unknown, hooks?: { onSent?: () => void }) =>
      new Promise(() => {
        st.taskCalls++;
        hooks?.onSent?.();
        if (st.accept) {
          st.capExists = true;
          st.started++;
        }
      }),
    stopCapOn: async () => ({ bantou: 1, type: "stop_result", ok: true, stopped: true }),
  } as unknown as ServerLink;
  const store = createJsonListStore<RemoteRecord>(join(dir, "remotes.json"), () => {});
  const mgr = createRemoteManager({
    link, store, log: () => {}, capId: CENTER, activity, graceMs: 60, pollMs: 40,
    ackTimeoutMs: 200, ackPollMs: 10, reachCheckMs: 0, reachThreshold: 2,
    onSummaryChange: (s) => changes.push(s),
    ...extra,
  });
  return { mgr, st, activity, changes };
}

test("remote_send: server が task を受け付けた（status の cap が変わった）ら delivered:true と送達時刻。pending は accepted", async () => {
  const { mgr } = setup();
  const r = await mgr.send({ owner: "pm1", goal: "go" });
  assert.equal(r.delivered, true);
  assert.equal(r.delivery, "accepted");
  assert.match(r.delivered_at ?? "", /^\d{4}-\d\d-\d\dT/);
  assert.equal(r.error, undefined);
  const [v] = mgr.list();
  assert.equal(v.pending[0].delivery, "accepted");
  assert.ok(v.pending[0].sent_at);
  assert.ok(v.pending[0].accepted_at);
  assert.equal(v.reachability.reachable, true);
  assert.ok(v.reachability.last_ok_at);
});

test("remote_send: 受付を確認できない（ack timeout）なら delivered:false。pending に sent で残り、後で受付が分かれば accepted になる", async () => {
  const { mgr, st } = setup();
  st.accept = false;
  const t0 = Date.now();
  const r = await mgr.send({ owner: "pm1", goal: "go" });
  assert.ok(Date.now() - t0 >= 190, "ack timeout まで待つ");
  assert.equal(r.delivered, false);
  assert.equal(r.delivery, "sent");
  assert.equal(r.delivered_at, undefined);
  assert.match(r.error ?? "", /届いていない可能性/);
  assert.ok(r.task_id);
  const [v] = mgr.list();
  assert.equal(v.pending.length, 1);
  assert.equal(v.pending[0].delivery, "sent");
  // 後から server が受け付けたと分かる（status の cap が変わる）
  st.capExists = true;
  st.started++;
  await mgr.checkReachability();
  assert.equal(mgr.list()[0].pending[0].delivery, "accepted");
});

test("remote_send: 受付未確認の同じ指示は再送しない（task を二重に送らず、確認だけやり直す）。違う指示は送る", async () => {
  const { mgr, st } = setup();
  st.accept = false;
  const a = await mgr.send({ owner: "pm1", goal: "same" });
  assert.equal(a.delivered, false);
  assert.equal(st.taskCalls, 1);
  const b = await mgr.send({ owner: "pm1", goal: "same" });
  assert.equal(st.taskCalls, 1, "再送しない");
  assert.equal(b.task_id, a.task_id);
  assert.equal(b.delivered, false);
  assert.equal(mgr.list()[0].pending.length, 1);
  // 確認の途中で受け付けられていれば delivered:true で返る
  st.capExists = true;
  st.started++;
  const c = await mgr.send({ owner: "pm1", goal: "same" });
  assert.equal(st.taskCalls, 1);
  assert.equal(c.delivered, true);
  assert.equal(c.task_id, a.task_id);
  const d = await mgr.send({ owner: "pm1", goal: "other" });
  assert.equal(st.taskCalls, 2);
  assert.notEqual(d.task_id, a.task_id);
});

test("remote_send の tool: delivered:false は isError（本文に delivered:false と task_id）。delivered:true は通常の結果", async () => {
  const { mgr, st } = setup();
  const handlers = new Map<string, (a: Record<string, unknown>) => Promise<{ isError?: boolean; content: { text: string }[] }>>();
  const fake = { registerTool: (name: string, _d: unknown, h: never) => handlers.set(name, h) } as never;
  registerSessionTools(fake, { remotes: mgr, owner: "pm1" } as never);
  const okRes = await handlers.get("remote_send")!({ goal: "a" });
  assert.notEqual(okRes.isError, true);
  assert.equal(JSON.parse(okRes.content[0].text).delivered, true);
  st.accept = false;
  const ng = await handlers.get("remote_send")!({ goal: "b" });
  assert.equal(ng.isError, true);
  const body = JSON.parse(ng.content[0].text);
  assert.equal(body.delivered, false);
  assert.ok(body.task_id);
});

test("到達性: hello / status が連続して返らないと reachable:false・state unknown・cap_state unknown・summary.unreachable。返れば戻る。SSE（onSummaryChange）が出る", async () => {
  const { mgr, st, changes } = setup();
  await mgr.send({ owner: "pm1", goal: "go" });
  assert.equal(mgr.list()[0].state, "running");
  assert.deepEqual(mgr.summary("pm1").unreachable, undefined);
  changes.length = 0;
  st.down = true;
  await mgr.checkReachability();
  assert.equal(mgr.list()[0].reachability.reachable, true, "1 回の失敗では揺らさない");
  assert.equal(mgr.list()[0].reachability.failures, 1);
  await mgr.checkReachability();
  const v = mgr.list()[0];
  assert.equal(v.reachability.reachable, false);
  assert.equal(v.reachability.failures, 2);
  assert.ok(v.reachability.last_ok_at);
  assert.match(v.reachability.last_error ?? "", /返信が来ない/);
  assert.equal(v.state, "unknown");
  assert.equal(v.cap_state, "unknown");
  const sum = mgr.summary("pm1");
  assert.equal(sum.unreachable?.length, 1);
  assert.equal(sum.unreachable?.[0].remoteId, CAP);
  assert.equal(sum.unreachable?.[0].lastOkAt, v.reachability.last_ok_at);
  assert.ok(changes.includes("pm1"), "session へ変更通知（SSE reason remote）");
  // 戻る
  changes.length = 0;
  st.down = false;
  await mgr.checkReachability();
  const back = mgr.list()[0];
  assert.equal(back.reachability.reachable, true);
  assert.equal(back.reachability.failures, 0);
  assert.notEqual(back.state, "unknown");
  assert.equal(mgr.summary("pm1").unreachable, undefined);
  assert.ok(changes.includes("pm1"));
});

test("到達性: follow の hello タイムアウト（noteReach）も数える。記録の無い server は無視", async () => {
  const { mgr, changes } = setup();
  mgr.noteReach(peerA, false, "hello に答えない");
  await mgr.send({ owner: "pm1", goal: "go" });
  mgr.noteReach(peerA, false, "hello timeout");
  assert.equal(mgr.list()[0].reachability.reachable, true);
  mgr.noteReach(peerA, false, "hello timeout");
  assert.equal(mgr.list()[0].reachability.reachable, false);
  assert.equal(mgr.list()[0].state, "unknown");
  assert.ok(changes.includes("pm1"));
  mgr.noteReach(peerA, true);
  assert.equal(mgr.list()[0].reachability.reachable, true);
});

test("cap lost の通知で cap_state が lost・state failed・summary.lost。新しい task が動けば戻る。SSE が出る", async () => {
  const { mgr, activity, changes } = setup();
  await mgr.send({ owner: "pm1", goal: "go" });
  changes.length = 0;
  const notice = (state: string) => ({
    bantou: 1 as const, type: "activity" as const, cap_id: CAP, at: "2026-11-10T00:00:00.000Z",
    agents: [{ kind: "cap" as const, id: CAP, cap_id: CAP, state: state as never, task: "t", last_activity: null, last_output_at: null, silent_ms: 0, started_at: null, finished_at: null, ...(state === "lost" ? { error: "server restarted" } : {}) }],
  });
  activity.apply(notice("lost"), "id-a");
  mgr.onActivity(CAP, "id-a");
  await tick();
  const v = mgr.list()[0];
  assert.equal(v.cap_state, "lost");
  assert.equal(v.state, "failed");
  assert.match(v.error ?? "", /lost/);
  const sum = mgr.summary("pm1");
  assert.equal(sum.lost?.length, 1);
  assert.equal(sum.lost?.[0].remoteId, CAP);
  assert.ok(changes.includes("pm1"));
  changes.length = 0;
  // cap が動き直した
  activity.apply(notice("running"), "id-a");
  mgr.onActivity(CAP, "id-a");
  await tick();
  assert.notEqual(mgr.list()[0].cap_state, "lost");
  assert.equal(mgr.summary("pm1").lost, undefined);
  assert.ok(changes.includes("pm1"));
});
