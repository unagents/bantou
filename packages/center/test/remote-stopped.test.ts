import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { createActivityStore } from "../src/activity.js";
import { createRemoteManager, type RemoteRecord } from "../src/remotes.js";
import type { ServerLink, ServerPeer } from "../src/server-link.js";
import { createJsonListStore } from "../src/store.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "center-stop-"));
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
  const sent: { owner: string; text: string }[] = [];
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
    stopCapOn: async () => ({ bantou: 1, type: "stop_result", ok: true, stopped: true, session_cleared: true }),
  } as unknown as ServerLink;
  const store = createJsonListStore<RemoteRecord>(join(dir, "remotes.json"), () => {});
  const mgr = createRemoteManager({
    link, store, log: () => {}, capId: CENTER, activity, graceMs: 60, pollMs: 40,
    ackTimeoutMs: 200, ackPollMs: 10, reachCheckMs: 0, reachThreshold: 2, reachRetryMs: 20_000, reachRequestDelayMs: 0, now: () => clock.t,
    onSummaryChange: (s) => changes.push(s),
    notify: async (owner: string, text: string) => (sent.push({ owner, text }), { ok: true as const }),
    ...extra,
  });
  return { mgr, st, activity, changes, clock, link, store, sent };
}


const result = (taskId: string, state: "done" | "failed", summary: string, error?: string) => ({
  bantou: 1, type: "task_result", cap_id: CAP, task_id: taskId, state, summary, ...(error ? { error } : {}), workers: [], review: { verdict: "unknown", items: [], rounds: 0 }, remaining: [],
});
const notice = (state: string) => ({
  bantou: 1 as const, type: "activity" as const, cap_id: CAP, at: "2026-11-10T00:00:00.000Z",
  agents: [{ kind: "cap" as const, id: CAP, cap_id: CAP, state: state as never, task: "t", last_activity: null, last_output_at: null, silent_ms: 0, started_at: null, finished_at: null, ...(state === "lost" ? { error: "server restarted" } : {}) }],
});
const pushes = (sent: { text: string }[], head: string): { text: string }[] => sent.filter((x) => x.text.startsWith(head));

test("止まった印(task failed): 印が出て master-cap へ push が届く。次の指示（remote_send）で印が消える。見るだけ（remote_list）では消えない", async () => {
  const { mgr, st, sent, changes } = setup();
  const r = await mgr.send({ owner: "pm1", goal: "go" });
  assert.equal(mgr.summary("pm1").stopped, undefined);
  st.running = false; // cap の turn が終わって止まった
  st.results[0](result(r.task_id, "failed", "broke", "終了コード 1"));
  await sleep(250);
  const sum = mgr.summary("pm1");
  assert.equal(sum.stopped?.length, 1);
  assert.equal(sum.stopped?.[0].kind, "failed");
  assert.equal(sum.stopped?.[0].remoteId, CAP);
  assert.equal(sum.stopped?.[0].taskId, r.task_id);
  assert.match(sum.stopped?.[0].detail ?? "", /終了コード 1/);
  assert.equal(pushes(sent, "[bantou] remote 完了").length, 1);
  assert.match(sent[0].text, /state=failed/);
  assert.ok(changes.includes("pm1"), "印の変化が session_list の更新（SSE）を起こす");
  mgr.list({ owner: "pm1" }); // 見ただけでは扱った事にならない
  assert.equal(mgr.summary("pm1").stopped?.length, 1);
  changes.length = 0;
  await mgr.send({ owner: "pm1", goal: "retry" }); // 次の指示 = 扱った
  assert.equal(mgr.summary("pm1").stopped, undefined);
  assert.ok(changes.includes("pm1"));
});

test("止まった印(cap lost): lost の印と push（state=failed）が出る。印は新しい task で消える", async () => {
  const { mgr, activity, sent } = setup();
  await mgr.send({ owner: "pm1", goal: "go" });
  activity.apply(notice("lost"), "id-a");
  mgr.onActivity(CAP, "id-a");
  await tick();
  assert.equal(mgr.summary("pm1").lost?.length, 1);
  assert.equal(pushes(sent, "[bantou] remote 完了").length, 1);
  assert.match(sent[0].text, /state=failed/);
  await mgr.send({ owner: "pm1", goal: "again" });
  assert.equal(mgr.summary("pm1").lost, undefined);
});

test("止まった印(到達不能): 印が出て、障害ごとに 1 回 push が届く（周期の確認のたびに重ねない）。戻れば印が消え、次の障害でまた届く。cap を閉じれば（delete）消える", async () => {
  const { mgr, st, clock, sent } = setup();
  await mgr.send({ owner: "pm1", goal: "go" });
  st.down = true;
  for (let i = 0; i < 4; i++) {
    await mgr.checkReachability();
    clock.t += 21_000;
  }
  await tick();
  assert.equal(mgr.summary("pm1").unreachable?.length, 1);
  assert.equal(pushes(sent, "[bantou] remote 到達不能").length, 1, "確認を重ねても 1 回");
  assert.match(sent[0].text, new RegExp(`remote_id=${CAP}`));
  st.down = false;
  await mgr.checkReachability();
  assert.equal(mgr.summary("pm1").unreachable, undefined);
  st.down = true;
  for (let i = 0; i < 3; i++) {
    await mgr.checkReachability();
    clock.t += 21_000;
  }
  await tick();
  assert.equal(pushes(sent, "[bantou] remote 到達不能").length, 2, "次の障害でまた届く");
  await mgr.delete({ remote_id: CAP, owner: "pm1", force: true });
  assert.equal(mgr.summary("pm1").unreachable, undefined);
});

test("止まった印(結果が返らず止まった): 再起動後、cap が task の途中で止まっていて結果が無い → no_result の印と push。次の指示で消える", async () => {
  const a = setup();
  await a.mgr.send({ owner: "pm1", goal: "go" });
  a.st.running = false; // cap は止まったが、task の結果は返らないまま center が再起動した
  const sent: { owner: string; text: string }[] = [];
  const { createRemoteManager: make } = await import("../src/remotes.js");
  const mgr2 = make({ link: a.link, store: a.store, log: () => {}, capId: CENTER, graceMs: 60, pollMs: 40, ackTimeoutMs: 200, ackPollMs: 10, reachCheckMs: 0, notify: async (owner, text) => (sent.push({ owner, text }), { ok: true as const }) });
  await mgr2.restore();
  await sleep(300);
  const sum = mgr2.summary("pm1");
  assert.equal(sum.stopped?.length, 1);
  assert.equal(sum.stopped?.[0].kind, "no_result");
  assert.equal(pushes(sent, "[bantou] remote 完了").length, 1);
  assert.match(sent[0].text, /note: task の結果が返らないまま/);
  a.st.running = true;
  await mgr2.send({ owner: "pm1", goal: "next" });
  assert.equal(mgr2.summary("pm1").stopped, undefined);
});

test("止まった印(定期の掬い上げ): activity が「動いている」と言ったまま途絶え、cap は止まっている。周期の確認（checkReachability）が status を見て完了判定に回し、push が届く", async () => {
  const { mgr, st, activity, sent } = setup();
  const r = await mgr.send({ owner: "pm1", goal: "go" });
  st.running = false;
  st.results[0](result(r.task_id, "done", "first turn"));
  await tick();
  activity.apply(notice("running"), "id-a"); // 最後の activity は running。この後 server から来ない
  mgr.onActivity(CAP, "id-a");
  await sleep(150);
  assert.equal(pushes(sent, "[bantou] remote 完了").length, 0, "activity が running なので、周期の確認の前は完了にならない");
  assert.equal(mgr.list()[0].pending.length, 1);
  await mgr.checkReachability();
  await sleep(150);
  assert.equal(pushes(sent, "[bantou] remote 完了").length, 1);
  assert.equal(mgr.list()[0].pending.length, 0);
});

test("止まった印(定期の掬い上げ・結果なし): 再起動後、task_result が来ず、activity は running のまま途絶え、status は idle。周期の確認で no_result の印と push 1 回。次の remote_send で消える", async () => {
  const a = setup();
  await a.mgr.send({ owner: "pm1", goal: "go" });
  a.st.running = false; // cap は task の途中でターンを終えて止まった。task_result は返らないまま center が再起動した
  a.activity.apply(notice("running"), "id-a"); // 最後の activity は running。この後 server から来ない
  const sent: { owner: string; text: string }[] = [];
  const mgr2 = createRemoteManager({ link: a.link, store: a.store, log: () => {}, capId: CENTER, activity: a.activity, graceMs: 60, pollMs: 40, ackTimeoutMs: 200, ackPollMs: 10, reachCheckMs: 0, notify: async (owner, text) => (sent.push({ owner, text }), { ok: true as const }) });
  await mgr2.restore();
  await mgr2.checkReachability(); // 周期の確認（status は idle）
  await sleep(300);
  const sum = mgr2.summary("pm1");
  assert.equal(sum.stopped?.length, 1);
  assert.equal(sum.stopped?.[0].kind, "no_result");
  assert.equal(pushes(sent, "[bantou] remote 完了").length, 1);
  assert.match(sent[0].text, /note: task の結果が返らないまま/);
  await mgr2.checkReachability(); // 周期を重ねても重複しない
  await sleep(150);
  assert.equal(pushes(sent, "[bantou] remote 完了").length, 1);
  a.st.running = true;
  await mgr2.send({ owner: "pm1", goal: "next" });
  assert.equal(mgr2.summary("pm1").stopped, undefined);
});

test("止まった印(返信待ちのまま止まった): 返信待ちが開いたまま周期の status で連続 2 回 idle → no_result の印と push 1 回（重ねない）。次の指示で消える", async () => {
  const { mgr, st, sent } = setup();
  await mgr.send({ owner: "pm1", goal: "go" });
  st.running = false; // cap は止まったが task_result は返らない（返信待ちは開いたまま）
  await mgr.checkReachability(); // 1 回目: まだ印は付かない
  await tick();
  assert.equal(mgr.summary("pm1").stopped, undefined);
  assert.equal(pushes(sent, "[bantou] remote 完了").length, 0);
  await sleep(5);
  await mgr.checkReachability(); // 連続 2 回目
  await tick();
  assert.equal(mgr.summary("pm1").stopped?.[0].kind, "no_result");
  assert.equal(pushes(sent, "[bantou] remote 完了").length, 1);
  assert.match(sent[0].text, /note: task の結果が返らないまま/);
  for (let i = 0; i < 3; i++) {
    await sleep(5);
    await mgr.checkReachability();
  }
  await tick();
  assert.equal(pushes(sent, "[bantou] remote 完了").length, 1, "周期を重ねても二重にならない");
  st.running = true;
  await mgr.send({ owner: "pm1", goal: "next" });
  assert.equal(mgr.summary("pm1").stopped, undefined);
});

test("止まった印(返信待ちのまま止まった): 連続でなければ印は付かない（途中で動けば数え直し）", async () => {
  const { mgr, st, sent } = setup();
  await mgr.send({ owner: "pm1", goal: "go" });
  st.running = false;
  await mgr.checkReachability();
  st.running = true;
  await sleep(5);
  await mgr.checkReachability();
  st.running = false;
  await sleep(5);
  await mgr.checkReachability();
  await tick();
  assert.equal(mgr.summary("pm1").stopped, undefined);
  assert.equal(pushes(sent, "[bantou] remote 完了").length, 0);
});

test("止まった印(返信待ちのまま止まった): 印の後に task_result が届けば通常の完了になり、印は消える", async () => {
  const { mgr, st, sent } = setup();
  const r = await mgr.send({ owner: "pm1", goal: "go" });
  st.running = false;
  await mgr.checkReachability();
  await sleep(5);
  await mgr.checkReachability();
  await tick();
  assert.equal(mgr.summary("pm1").stopped?.[0].kind, "no_result");
  st.results[0](result(r.task_id, "done", "late result"));
  await sleep(250);
  assert.equal(mgr.summary("pm1").stopped, undefined);
  assert.equal(mgr.list()[0].pending.length, 0);
  const done = pushes(sent, "[bantou] remote 完了");
  assert.equal(done.length, 2, "止まった知らせ 1 回 + 通常の完了 1 回");
  assert.match(done[1].text, /late result/);
  assert.doesNotMatch(done[1].text, /note: task の結果が返らないまま/);
});
