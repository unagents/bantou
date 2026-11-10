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

/**
 * fake の server link。server は task を受けると cap の last_started_at と負荷を進める（accept=false なら受け付けない = 届かない）。down=true は無返信。
 * landAt: status の呼び出し回数がこれに達した時に cap が現れる（先行する task が遅れて届く状況）。failSend: messenger へ送り出す前に失敗する。
 */
function setup(extra: Partial<Parameters<typeof createRemoteManager>[0]> = {}) {
  const st = { accept: true, down: false, started: 0, running: false, queued: 0, taskCalls: 0, statusCalls: 0, capExists: false, landAt: -1, failSend: false, results: [] as ((r: unknown) => void)[] };
  const activity = createActivityStore();
  const changes: string[] = [];
  const clock = { t: Date.parse("2026-11-10T00:00:00Z") };
  const link = {
    peers: async () => [peerA],
    identifiedPeers: async () => [peerA],
    selectPeer: async () => peerA,
    statusOn: async () => {
      st.statusCalls++;
      if (st.landAt >= 0 && st.statusCalls >= st.landAt) {
        st.capExists = true;
        st.running = true;
        st.started++;
        st.landAt = -1;
      }
      if (st.down) return { bantou: 1, type: "error", ok: false, message: "返信が来ない（status）", transport: true } as never;
      return {
        bantou: 1, type: "status_result", ok: true, workers: [],
        caps: st.capExists ? [{ kind: "cap", id: CAP, state: st.running ? "running" : "idle", queued: st.queued, last_started_at: st.started === 0 ? null : `s${st.started}` }] : [],
      } as never;
    },
    taskOn: (_p: ServerPeer, _c: unknown, hooks?: { onSent?: () => void }) =>
      new Promise((resolve) => {
        if (st.failSend) {
          resolve({ bantou: 1, type: "error", ok: false, message: "送信失敗: broker に繋がらない", transport: true });
          return;
        }
        st.taskCalls++;
        st.results.push(resolve);
        hooks?.onSent?.();
        if (st.accept) {
          // 既に実行中なら待ちに入る。そうでなければ cap が動き出す
          if (st.running) st.queued++;
          else {
            st.capExists = true;
            st.running = true;
            st.started++;
          }
        }
      }),
    stopCapOn: async () => ({ bantou: 1, type: "stop_result", ok: true, stopped: true }),
  } as unknown as ServerLink;
  const store = createJsonListStore<RemoteRecord>(join(dir, "remotes.json"), () => {});
  const mgr = createRemoteManager({
    link, store, log: () => {}, capId: CENTER, activity, graceMs: 60, pollMs: 40,
    ackTimeoutMs: 200, ackPollMs: 10, reachCheckMs: 0, reachThreshold: 2, reachRetryMs: 20_000, reachRequestDelayMs: 0, now: () => clock.t,
    onSummaryChange: (s) => changes.push(s),
    ...extra,
  });
  return { mgr, st, activity, changes, clock };
}

const taskResult = (taskId: string) => ({ bantou: 1, type: "task_result", cap_id: CAP, task_id: taskId, state: "done", summary: "R", workers: [], review: { verdict: "unknown", items: [], rounds: 0 }, remaining: [] });

test("remote_send: server への到達を観測（status の cap が変わった）したら delivered:true と送達時刻。pending は observed", async () => {
  const { mgr } = setup();
  const r = await mgr.send({ owner: "pm1", goal: "go" });
  assert.equal(r.delivered, true);
  assert.equal(r.delivery, "observed");
  assert.match(r.delivered_at ?? "", /^\d{4}-\d\d-\d\dT/);
  assert.equal(r.error, undefined);
  const [v] = mgr.list();
  assert.equal(v.pending[0].delivery, "observed");
  assert.ok(v.pending[0].sent_at);
  assert.ok(v.pending[0].observed_at);
  assert.equal(v.reachability.reachable, true);
  assert.ok(v.reachability.last_ok_at);
});

test("remote_send: 受付を確認できない（ack timeout）なら delivered:false。pending に sent で残り、周期の status では格上げされず、task_result で observed（根拠 task_result）になる", async () => {
  const { mgr, st } = setup();
  st.accept = false;
  const t0 = Date.now();
  const r = await mgr.send({ owner: "pm1", goal: "go" });
  assert.ok(Date.now() - t0 >= 190, "ack timeout まで待つ");
  assert.equal(r.delivered, false);
  assert.equal(r.delivery, "sent");
  assert.equal(r.delivered_at, undefined);
  assert.equal(r.delivery_basis, undefined);
  assert.match(r.error ?? "", /届いていない可能性/);
  assert.match(r.error ?? "", /再送する前に remote_list で delivery を確認/);
  assert.ok(r.task_id);
  assert.equal(mgr.list()[0].pending[0].delivery, "sent");
  // 後から cap が動いた（別の要因かもしれない）。周期の status では observed に格上げしない
  st.capExists = true;
  st.running = true;
  st.started++;
  await mgr.checkReachability();
  assert.equal(mgr.list()[0].pending[0].delivery, "sent");
  // task_result が返れば確実
  st.results[0](taskResult(r.task_id));
  await tick();
  const p = mgr.list()[0].pending[0];
  assert.ok(p === undefined || (p.delivery === "observed" && p.delivery_basis === "task_result"));
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
  // 確認の途中で cap が現れていれば delivered:true で返る（直接の観測）
  st.landAt = st.statusCalls + 3;
  const c = await mgr.send({ owner: "pm1", goal: "same" });
  assert.equal(st.taskCalls, 1);
  assert.equal(c.delivered, true);
  assert.equal(c.delivery_basis, "status");
  assert.equal(c.task_id, a.task_id);
  const d = await mgr.send({ owner: "pm1", goal: "other" });
  assert.equal(st.taskCalls, 2);
  assert.notEqual(d.task_id, a.task_id);
});

test("受付判定(c): 先行する task が未確認の間に送った 2 本目は、先行する task の到着だけでは observed にならない", async () => {
  const { mgr, st } = setup();
  st.accept = false;
  const a = await mgr.send({ owner: "pm1", goal: "first" });
  assert.equal(a.delivered, false);
  // 2 本目を送る。直列の中の status では cap はまだ無く、確認の 2 回目の status で 1 本目が届いて cap が動き出す
  st.landAt = st.statusCalls + 2;
  const b = await mgr.send({ owner: "pm1", goal: "second" });
  assert.equal(st.taskCalls, 2);
  assert.equal(b.delivered, false, "2 本目は 1 本目の到着で observed にならない");
  assert.equal(b.delivery, "sent");
  assert.deepEqual(mgr.list()[0].pending.map((p) => p.delivery), ["sent", "sent"]);
});

test("受付判定(c): 先行する task が既に status に見えていれば受付済みにし、2 本目はそこからの増加（待ちの増加）で受付になる", async () => {
  const { mgr, st } = setup();
  const a = await mgr.send({ owner: "pm1", goal: "first" });
  assert.equal(a.delivered, true);
  const b = await mgr.send({ owner: "pm1", goal: "second" });
  assert.equal(b.delivered, true, "cap が実行中なら待ちが増えて受付");
  assert.equal(st.queued, 1);
  assert.deepEqual(mgr.list()[0].pending.map((p) => p.delivery), ["observed", "observed"]);
});

// 既知の限界（受付判定(a)）: server は task を受けた時だけでなく、worker の report 起因の resume でも cap を running にして last_started_at を更新する。
// status の変化だけでは両者を区別できないので、届いていない task が observed（根拠 status）になる偽陽性が理論上ある。server に task の ack が要る。
test("受付判定(a)の限界: 根拠は status（推定）。delivery_basis に出る", async () => {
  const { mgr } = setup();
  const r = await mgr.send({ owner: "pm1", goal: "go" });
  assert.equal(r.delivery_basis, "status");
  assert.equal(mgr.list()[0].pending[0].delivery_basis, "status");
});

test("remote_send: 受付確認は server の直列の外で待つ。別 session の送信が互いの ack 待ちで直列にならない", async () => {
  const { mgr, st } = setup();
  st.accept = false;
  const t0 = Date.now();
  const rs = await Promise.all([mgr.send({ owner: "pm1", goal: "a" }), mgr.send({ owner: "pm2", goal: "b" }), mgr.send({ owner: "pm3", goal: "c" })]);
  const took = Date.now() - t0;
  assert.equal(rs.filter((x) => !x.delivered).length, 3);
  assert.ok(took < 450, `3 本が 1 本分の ack 待ち（約 200ms）で終わる: ${took}ms`);
});

test("remote_send: messenger へ送り出せなかった task は pending に unsent で残り（記録も残る）、再送は止めない", async () => {
  const { mgr, st } = setup();
  st.failSend = true;
  const r = await mgr.send({ owner: "pm1", goal: "go" });
  assert.equal(r.delivered, false);
  assert.equal(r.delivery, "unsent");
  assert.match(r.error ?? "", /server には届いていない/);
  assert.match(r.error ?? "", /未送信（unsent）/);
  const [v] = mgr.list();
  assert.equal(v.pending.length, 1);
  assert.equal(v.pending[0].delivery, "unsent");
  assert.equal(st.taskCalls, 0);
  // 同じ指示を再び送れる（再送抑止の対象にしない）
  st.failSend = false;
  const again = await mgr.send({ owner: "pm1", goal: "go" });
  assert.equal(st.taskCalls, 1);
  assert.equal(again.delivered, true);
  assert.notEqual(again.task_id, r.task_id);
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

test("到達性: 同時刻の複数経路（hello・status）の失敗は 1 回に束ねられ unknown にならない。REACH_RETRY_MS 経過後の再失敗で 2 回目になり unknown。成功で戻る。SSE が出る", async () => {
  const { mgr, st, changes, clock } = setup();
  await mgr.send({ owner: "pm1", goal: "go" });
  assert.equal(mgr.list()[0].state, "running");
  assert.equal(mgr.summary("pm1").unreachable, undefined);
  changes.length = 0;
  st.down = true;
  // 1 回の障害で、follow の hello・周期の status・同じ server の他経路が同時刻に失敗する
  mgr.noteReach(peerA, false, "hello timeout");
  await Promise.all([mgr.checkReachability(), mgr.checkReachability()]);
  mgr.noteReach(peerA, false, "hello timeout");
  await sleep(30);
  assert.equal(mgr.list()[0].reachability.failures, 1);
  assert.equal(mgr.list()[0].reachability.reachable, true);
  assert.notEqual(mgr.list()[0].state, "unknown");
  // 束ね窓の内（19 秒後）の失敗も同じ 1 回
  clock.t += 19_000;
  await mgr.checkReachability();
  assert.equal(mgr.list()[0].reachability.failures, 1);
  assert.equal(mgr.list()[0].reachability.reachable, true);
  // 最後に数えた失敗から REACH_RETRY_MS（20 秒）経過後の失敗は 2 回目
  clock.t += 1_000;
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
  // 戻る。成功で束ねの基準もリセットされ、直後の 1 回の失敗は 1 回目として数える
  changes.length = 0;
  st.down = false;
  await mgr.checkReachability();
  const back = mgr.list()[0];
  assert.equal(back.reachability.reachable, true);
  assert.equal(back.reachability.failures, 0);
  assert.notEqual(back.state, "unknown");
  assert.equal(mgr.summary("pm1").unreachable, undefined);
  assert.ok(changes.includes("pm1"));
  st.down = true;
  await mgr.checkReachability();
  assert.equal(mgr.list()[0].reachability.failures, 1);
  assert.equal(mgr.list()[0].reachability.reachable, true);
});

test("到達性: hello・受付確認などの失敗は failures を直接数えず、再確認(checkReachability)を起こす。再確認が成功すれば数えない。連続して失敗した時だけ到達不能", async () => {
  const { mgr, st, changes, clock } = setup();
  mgr.noteReach(peerA, false, "hello に答えない");
  await mgr.send({ owner: "pm1", goal: "go" });
  // hello だけが失敗（server は status に答える）: 再確認が成功するので数えない
  mgr.noteReach(peerA, false, "hello timeout");
  mgr.noteReach(peerA, false, "hello timeout");
  await sleep(30);
  assert.equal(mgr.list()[0].reachability.failures, 0);
  assert.equal(mgr.list()[0].reachability.reachable, true);
  // server が本当に止まった: 再確認が失敗して 1 回目。窓の内の hello 失敗は増やさない
  st.down = true;
  mgr.noteReach(peerA, false, "hello timeout");
  await sleep(30);
  assert.equal(mgr.list()[0].reachability.failures, 1);
  mgr.noteReach(peerA, false, "hello timeout");
  await sleep(30);
  assert.equal(mgr.list()[0].reachability.failures, 1);
  assert.equal(mgr.list()[0].reachability.reachable, true);
  // REACH_RETRY_MS 経過後の再確認の失敗で 2 回目
  clock.t += 20_000;
  mgr.noteReach(peerA, false, "hello timeout");
  await sleep(30);
  assert.equal(mgr.list()[0].reachability.reachable, false);
  assert.equal(mgr.list()[0].state, "unknown");
  assert.ok(changes.includes("pm1"));
  // hello が成功しても戻らない（cap に係る応答ではない）。status の成功で戻る
  st.down = false;
  mgr.noteReach(peerA, true);
  assert.equal(mgr.list()[0].reachability.reachable, false);
  await mgr.checkReachability();
  assert.equal(mgr.list()[0].reachability.reachable, true);
  assert.equal(mgr.list()[0].reachability.failures, 0);
});

test("到達性(S1): hello は成功するが status に答えない server は、hello 成功で failures を戻されず、checkReachability の連続 2 回の失敗で到達不能。status の成功で復帰。last_error に原因", async () => {
  const { mgr, st, clock } = setup();
  await mgr.send({ owner: "pm1", goal: "go" });
  st.down = true; // status だけ無応答
  const okBefore = mgr.list()[0].reachability.last_ok_at;
  for (let i = 0; i < 4; i++) {
    mgr.noteReach(peerA, true); // hello は毎回成功
    await mgr.checkReachability();
    clock.t += 21_000;
    if (i === 0) assert.equal(mgr.list()[0].reachability.reachable, true, "1 回目の失敗では到達不能にしない");
    if (i >= 1) assert.equal(mgr.list()[0].reachability.reachable, false, "2 回目の確認の失敗で到達不能");
  }
  const v = mgr.list()[0];
  assert.equal(v.state, "unknown");
  assert.equal(v.cap_state, "unknown");
  assert.match(v.reachability.last_error ?? "", /status に応答しない/);
  assert.notEqual(v.reachability.last_ok_at, okBefore, "最後の応答の時刻は hello でも更新する");
  assert.equal(mgr.summary("pm1").unreachable?.length, 1);
  // status が答えれば戻る
  st.down = false;
  await mgr.checkReachability();
  assert.equal(mgr.list()[0].reachability.reachable, true);
  assert.equal(mgr.list()[0].reachability.failures, 0);
  assert.equal(mgr.summary("pm1").unreachable, undefined);
});

test("到達性: 記録の無い server の hello 失敗は無視する", async () => {
  const { mgr, st } = setup();
  st.down = true;
  mgr.noteReach(peerA, false, "hello timeout");
  await sleep(30);
  assert.equal(st.statusCalls, 0, "記録が無ければ再確認もしない");
});

test("delivery_basis task_id: 自分の task_id の worker_report が届いたら observed（根拠 task_id）。他の task_id では変えない", async () => {
  const { mgr, st } = setup();
  st.accept = false;
  const r = await mgr.send({ owner: "pm1", goal: "go" });
  assert.equal(r.delivered, false);
  const rep = (task_id: string) => ({ bantou: 1, type: "worker_report", cap_id: CAP, task_id, worker_id: "w-1", kind: "done", text: "x", at: "2026-11-10T00:00:00.000Z" }) as never;
  mgr.onWorkerReport(rep("t-other"), "id-a");
  assert.equal(mgr.list()[0].pending[0].delivery, "sent");
  mgr.onWorkerReport(rep(r.task_id), "id-a");
  const p = mgr.list()[0].pending[0];
  assert.equal(p.delivery, "observed");
  assert.equal(p.delivery_basis, "task_id");
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
