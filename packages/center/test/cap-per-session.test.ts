import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { AGENT_ID_PATTERN } from "@agent-hand/bantou-protocol";
import { MAX_SESSION_NAME, sessionCapId } from "../src/center-id.js";
import { createActivityStore } from "../src/activity.js";
import { createRemoteManager, type RemoteRecord } from "../src/remotes.js";
import type { ServerLink, ServerPeer } from "../src/server-link.js";
import { createJsonListStore } from "../src/store.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "center-cps-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
});

const CENTER = "c-0123456789";
const peerA: ServerPeer = { id: "id-a", name: "bantou-server", hostname: "host-a", version: "1.1.0" };
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 10));

function setup(opts: { statusWorkers?: unknown[]; activity?: ReturnType<typeof createActivityStore> } = {}) {
  const kicks: { cmd: Record<string, unknown>; resolve: (r: unknown) => void }[] = [];
  const stops: unknown[] = [];
  const replies: unknown[] = [];
  const sent: { owner: string; text: string }[] = [];
  const link = {
    peers: async () => [peerA],
    selectPeer: async () => peerA,
    statusOn: async () => ({ bantou: 1, type: "status_result", ok: true, caps: kicks.map((k) => ({ kind: "cap", id: k.cmd.cap_id, state: "idle" })), workers: opts.statusWorkers ?? [] }),
    taskOn: (_p: ServerPeer, cmd: Record<string, unknown>) => new Promise((resolve) => kicks.push({ cmd, resolve })),
    stopCapOn: async (_p: ServerPeer, cmd: { cap_id: string }) => (stops.push(cmd), { bantou: 1, type: "stop_result", ok: true, cap_id: cmd.cap_id, stopped: true, session_cleared: true, previous_session_id: "s-old" }),
    workerReplyOn: async (_p: ServerPeer, cmd: { cap_id: string; worker_id: string }) => (replies.push(cmd), { bantou: 1, type: "worker_reply_result", ok: true, cap_id: cmd.cap_id, worker_id: cmd.worker_id, accepted: true }),
  } as unknown as ServerLink;
  const store = createJsonListStore<RemoteRecord>(join(dir, "remotes.json"), () => {});
  const mgr = createRemoteManager({
    link, store, log: () => {}, capId: CENTER, graceMs: 60, pollMs: 40, ...(opts.activity ? { activity: opts.activity } : {}),
    notify: async (owner, text) => (sent.push({ owner, text }), { ok: true }),
  });
  return { mgr, kicks, stops, replies, sent };
}

const result = (cap: string, taskId: string) => ({
  bantou: 1, type: "task_result", cap_id: cap, task_id: taskId, state: "done", summary: "ok",
  workers: [], review: { verdict: "unknown", items: [], rounds: 0 }, remaining: [],
});

// -- cap_id の変換 --

test("sessionCapId: 異なる (center-id, session) の組は必ず別の cap_id（center-id は固定長 10 桁 hex）。旧共有 cap とも一致しない", () => {
  const centers = ["c-0123456789", "c-0123456788", "c-abcdef0123"];
  const names = ["a", "b", "a-b", "b-a", "ab", "9", "9-a", "A", "a_b", "a-", "-a", "0123456789", "0123456789-a"];
  const seen = new Map<string, string>();
  for (const c of centers) {
    seen.set(c, "shared:" + c); // 旧共有 cap
    for (const n of names) {
      const id = sessionCapId(c, n);
      assert.equal(seen.has(id), false, id + " が " + seen.get(id) + " と衝突");
      seen.set(id, c + "/" + n);
    }
  }
});

test("sessionCapId: session 名が MAX_SESSION_NAME 文字を超えたら error（短縮しない）。上限ちょうどは通り 255 byte に収まる", () => {
  const max = "A".repeat(MAX_SESSION_NAME);
  const id = sessionCapId(CENTER, max);
  assert.ok(id.length <= 255 && id.length === CENTER.length + 1 + MAX_SESSION_NAME);
  assert.match(id, AGENT_ID_PATTERN);
  assert.throws(() => sessionCapId(CENTER, "A".repeat(MAX_SESSION_NAME + 1)), /文字まで/);
});

test("sessionCapId: c-<center-id>-<session 名>。session 名は cap_id と同じ文字種なので恒等。AGENT_ID_PATTERN を満たす", () => {
  assert.equal(sessionCapId(CENTER, "main"), "c-0123456789-main");
  assert.equal(sessionCapId(CENTER, "a_b-C9"), "c-0123456789-a_b-C9");
  assert.match(sessionCapId(CENTER, "a_b-C9"), AGENT_ID_PATTERN);
});

test("sessionCapId: 別の session 名は別の cap_id。旧共有 cap（c-<center-id>）とも一致しない", () => {
  const names = ["a", "b", "a-b", "a_b", "A", "a-", "-a", "1", "01"];
  const ids = names.map((n) => sessionCapId(CENTER, n));
  assert.equal(new Set(ids).size, names.length);
  assert.ok(!ids.includes(CENTER));
});

test("sessionCapId: 許可外の文字（. 空白 / 日本語 空）は拒否する（別の名前に寄せない）", () => {
  for (const bad of ["a.b", "a b", "a/b", "日本語", "", "a%2Fb"]) assert.throws(() => sessionCapId(CENTER, bad), /session 名/, bad);
});

// -- session ごとの cap --

test("send: session ごとに別の cap_id で task を送り、記録は session × server に 1 件。session を持つ", async () => {
  const { mgr, kicks } = setup();
  const a = await mgr.send({ owner: "alpha", goal: "g1" });
  const b = await mgr.send({ owner: "beta", goal: "g2" });
  const a2 = await mgr.send({ owner: "alpha", goal: "g3" });
  assert.deepEqual([a.remote_id, b.remote_id, a2.remote_id], ["c-0123456789-alpha", "c-0123456789-beta", "c-0123456789-alpha"]);
  assert.deepEqual([a.created, b.created, a2.created], [true, true, false]);
  assert.deepEqual(kicks.map((k) => k.cmd.cap_id), ["c-0123456789-alpha", "c-0123456789-beta", "c-0123456789-alpha"]);
  assert.deepEqual(mgr.list().map((r) => [r.remote_id, r.session]), [["c-0123456789-alpha", "alpha"], ["c-0123456789-beta", "beta"]]);
});

test("list: owner を渡すとその session の cap だけ。他の session の cap・指示・結果は見えない", async () => {
  const { mgr, kicks } = setup();
  await mgr.send({ owner: "alpha", goal: "alpha の秘密の指示" });
  await mgr.send({ owner: "beta", goal: "beta の指示" });
  kicks[0].resolve(result("c-0123456789-alpha", String(kicks[0].cmd.task_id)));
  await tick();
  const mine = mgr.list({ owner: "beta" });
  assert.deepEqual(mine.map((r) => r.remote_id), ["c-0123456789-beta"]);
  assert.ok(!JSON.stringify(mine).includes("秘密"));
  assert.deepEqual(mgr.list({ owner: "gamma" }), []);
  assert.equal(mgr.list().length, 2);
});

test("wait / delete / workerReply: owner の cap だけが対象。他の session の remote_id を指定しても見えない・触れない", async () => {
  const { mgr, stops, replies } = setup();
  await mgr.send({ owner: "alpha", goal: "a" });
  await mgr.send({ owner: "beta", goal: "b" });
  const alpha = "c-0123456789-alpha";
  await assert.rejects(mgr.wait({ remote_id: alpha, owner: "beta", timeoutSec: 1 }), /未定義/);
  await assert.rejects(mgr.delete({ remote_id: alpha, owner: "beta", force: true }), /未定義/);
  await assert.rejects(mgr.workerReply({ remote_id: alpha, owner: "beta", worker_id: "w-1", text: "x" }), /未定義/);
  assert.equal(stops.length, 0);
  assert.equal(replies.length, 0);
  assert.equal(mgr.list().length, 2);
  // remote_id 省略は自分の cap
  assert.equal((await mgr.workerReply({ owner: "beta", worker_id: "w-1", text: "y" })).remote_id, "c-0123456789-beta");
  assert.deepEqual(replies, [{ cap_id: "c-0123456789-beta", worker_id: "w-1", text: "y" }]);
  assert.equal((await mgr.delete({ owner: "beta", force: true })).remote_id, "c-0123456789-beta");
  assert.deepEqual(stops, [{ cap_id: "c-0123456789-beta" }]);
  assert.deepEqual(mgr.list().map((r) => r.remote_id), [alpha]);
});

test("wait: remote_id 省略は owner の cap で未完了の指示があるものだけ（他 session の指示では返らない）", async () => {
  const { mgr } = setup();
  await mgr.send({ owner: "alpha", goal: "a" });
  await assert.rejects(mgr.wait({ owner: "beta" }), /running の remote が無い/);
});

test("通知: 完了通知・worker_report は cap の session にだけ送る", async () => {
  const { mgr, kicks, sent } = setup();
  await mgr.send({ owner: "alpha", goal: "a" });
  await mgr.send({ owner: "beta", goal: "b" });
  mgr.onWorkerReport({ bantou: 1, type: "worker_report", cap_id: "c-0123456789-beta", task_id: "t", worker_id: "w-1", kind: "ask", text: "どっち？", at: "2026-11-04T00:00:00.000Z" } as never);
  await tick();
  assert.deepEqual(sent.map((s) => s.owner), ["beta"]);
  assert.match(sent[0].text, /remote_id=c-0123456789-beta/);
  kicks[0].resolve(result("c-0123456789-alpha", String(kicks[0].cmd.task_id)));
  await tick();
  mgr.onActivity("c-0123456789-alpha");
  await new Promise((r) => setTimeout(r, 120));
  assert.deepEqual(sent.map((s) => s.owner), ["beta", "alpha"]);
  assert.match(sent[1].text, /remote_id=c-0123456789-alpha/);
});

// -- 旧共有 cap の引き継ぎ --

const shared = (over: Record<string, unknown> = {}) => ({
  remote_id: CENTER, server: "id-a", serverName: "bantou-server", serverHost: "host-a", state: "done",
  createdAt: "2026-11-03T00:00:00.000Z", result: "旧共有の結果", pending: [], ...over,
});

test("restore: 旧共有 cap（c-<center-id>）は session 無しの記録として残り、stop_cap は送らない。session の記録と並ぶ", async () => {
  const sess = { ...shared({ remote_id: "c-0123456789-alpha", result: "alpha の結果" }), session: "alpha" };
  await writeFile(join(dir, "remotes.json"), JSON.stringify([shared(), sess]));
  const { mgr, stops } = setup();
  await mgr.restore();
  assert.equal(stops.length, 0);
  assert.deepEqual(mgr.list().map((r) => [r.remote_id, r.session]), [["c-0123456789-alpha", "alpha"], [CENTER, undefined]]);
  // session の一覧には出ない（include_shared で明示した時だけ出る）
  assert.deepEqual(mgr.list({ owner: "alpha" }).map((r) => r.remote_id), ["c-0123456789-alpha"]);
  assert.deepEqual(mgr.list({ owner: "alpha", includeShared: true }).map((r) => r.remote_id), ["c-0123456789-alpha", CENTER]);
  assert.deepEqual(mgr.list({ owner: "beta" }), []);
});

test("旧共有 cap へは新しい指示を送らない。send は session の cap_id で、旧共有 cap の記録は変わらない", async () => {
  await writeFile(join(dir, "remotes.json"), JSON.stringify([shared()]));
  const { mgr, kicks } = setup();
  await mgr.restore();
  const r = await mgr.send({ owner: "alpha", goal: "新しい指示" });
  assert.equal(r.remote_id, "c-0123456789-alpha");
  assert.equal(r.created, true);
  assert.deepEqual(kicks.map((k) => k.cmd.cap_id), ["c-0123456789-alpha"]);
  const old = mgr.list().find((x) => x.remote_id === CENTER)!;
  assert.deepEqual([old.session, old.result, old.pending], [undefined, "旧共有の結果", []]);
});

test("remote_delete: 旧共有 cap は remote_id で明示した時だけ消せる（remote_id 省略では対象にならない）", async () => {
  await writeFile(join(dir, "remotes.json"), JSON.stringify([shared()]));
  const { mgr, stops } = setup();
  await mgr.restore();
  await assert.rejects(mgr.delete({ owner: "alpha" }), /未定義/);
  assert.equal(stops.length, 0);
  const r = await mgr.delete({ remote_id: CENTER, owner: "alpha" });
  assert.deepEqual(r, { remote_id: CENTER, deleted: true, stopped: true, session_cleared: true, previous_session_id: "s-old" });
  assert.deepEqual(stops, [{ cap_id: CENTER }]);
  assert.deepEqual(mgr.list(), []);
});

test("remote_delete: 旧共有 cap の remote_id を指定しても、他の session の cap は消せない", async () => {
  await writeFile(join(dir, "remotes.json"), JSON.stringify([shared()]));
  const { mgr, stops } = setup();
  await mgr.restore();
  await mgr.send({ owner: "alpha", goal: "a" });
  await assert.rejects(mgr.delete({ remote_id: "c-0123456789-alpha", owner: "beta", force: true }), /未定義/);
  assert.equal(stops.length, 0);
});

test("旧共有 cap に未完了の指示があれば、その owner へ完了を通知する（引き継ぎ前の指示の後始末）", async () => {
  const pend = [{ at: "2026-11-03T00:00:00.000Z", owner: "alpha", prompt: "旧指示" }];
  await writeFile(join(dir, "remotes.json"), JSON.stringify([shared({ state: "done", pending: pend })]));
  const { mgr, sent } = setup();
  await mgr.restore();
  await new Promise((r) => setTimeout(r, 200));
  assert.ok(sent.every((s) => s.owner === "alpha"));
  assert.deepEqual(mgr.list().find((r) => r.remote_id === CENTER)!.session, undefined);
});

test("status での追従: 他 session の cap の worker が running でも、自分の cap は done になる（activity に載る worker だけを見る）", async () => {
  const activity = createActivityStore();
  const { mgr, kicks, sent } = setup({ statusWorkers: [{ kind: "worker", id: "w-other", state: "running" }], activity });
  await mgr.send({ owner: "alpha", goal: "a" });
  // alpha の cap の activity: cap は idle、worker 無し（w-other は beta の worker）
  activity.apply({ bantou: 1, type: "activity", cap_id: "c-0123456789-alpha", at: "2026-11-04T00:00:00.000Z", agents: [{ kind: "cap", id: "c-0123456789-alpha", cap_id: "c-0123456789-alpha", state: "idle", task: "t", last_activity: null, last_output_at: null, silent_ms: 0, started_at: null, finished_at: null }] } as never, "id-a");
  kicks[0].resolve(result("c-0123456789-alpha", String(kicks[0].cmd.task_id)));
  await new Promise((r) => setTimeout(r, 250));
  assert.equal(mgr.list({ owner: "alpha" })[0].state, "done");
  assert.deepEqual(sent.map((s) => s.owner), ["alpha"]);
});

test("remote_id 省略で 1 件に決まらない時（同じ server に別 session の cap が複数）は、remote_id での指定を促す", async () => {
  const { mgr } = setup();
  await mgr.send({ owner: "alpha", goal: "a" });
  await mgr.send({ owner: "beta", goal: "b" });
  await assert.rejects(mgr.delete({}), /remote_id 省略では 1 件に決まらない.*c-0123456789-alpha.*c-0123456789-beta/);
});
