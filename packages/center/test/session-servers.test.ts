import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { createRemoteManager, type RemoteRecord } from "../src/remotes.js";
import type { ServerLink, ServerPeer } from "../src/server-link.js";
import { createJsonListStore } from "../src/store.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "center-srv-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
});

const lenovoA: ServerPeer = { id: "p-la", name: "bantou-server", hostname: "lenovo", server_id: "srv-lenovo-a", host: "lenovo", user: "ua", workspace: "/a" };
const lenovoB: ServerPeer = { id: "p-lb", name: "bantou-server", hostname: "lenovo", server_id: "srv-lenovo-b", host: "lenovo", user: "ub", workspace: "/b" };
const mac: ServerPeer = { id: "p-mac", name: "bantou-server", hostname: "mac200", server_id: "srv-mac", host: "mac200", user: "um", workspace: "/m" };

/** 実の selectPeer と同じ段（server_id → peer id → host 名）で、同じ段に複数なら曖昧エラーにする偽 link。task は送った先を記録する。 */
function setup(servers: Record<string, string[] | undefined>, peers = [lenovoA, lenovoB, mac]) {
  const tasks: { peer: string; cap: string }[] = [];
  const stops: { peer: string; cap: string }[] = [];
  const replies: { peer: string; cap: string; worker: string }[] = [];
  const link = {
    peers: async () => peers,
    identifiedPeers: async () => peers,
    selectPeer: async (sel?: string) => {
      if (sel === undefined) return peers[0];
      for (const t of [(p: ServerPeer) => p.server_id === sel, (p: ServerPeer) => p.id === sel, (p: ServerPeer) => p.host === sel]) {
        const hit = peers.filter(t);
        if (hit.length === 1) return hit[0];
        if (hit.length > 1) throw new Error(`server の指定が曖昧: ${sel}`);
      }
      throw new Error(`server が見つからない: ${sel}`);
    },
    statusOn: async () => ({ bantou: 1, type: "status_result", ok: true, caps: [], workers: [] }),
    taskOn: async (p: ServerPeer, cmd: { cap_id: string }) => (tasks.push({ peer: p.id, cap: cmd.cap_id }), new Promise(() => {})),
    stopCapOn: async (p: ServerPeer, cmd: { cap_id: string }) => (stops.push({ peer: p.id, cap: cmd.cap_id }), { bantou: 1, type: "stop_result", ok: true, cap_id: cmd.cap_id, stopped: true, session_cleared: true, previous_session_id: "s-old" }),
    workerReplyOn: async (p: ServerPeer, cmd: { cap_id: string; worker_id: string }) => (replies.push({ peer: p.id, cap: cmd.cap_id, worker: cmd.worker_id }), { bantou: 1, type: "worker_reply_result", ok: true, cap_id: cmd.cap_id, worker_id: cmd.worker_id, accepted: true }),
  } as unknown as ServerLink;
  const store = createJsonListStore<RemoteRecord>(join(dir, "remotes.json"), () => {});
  const mgr = createRemoteManager({ link, store, log: () => {}, capId: "c-0123456789", serversOf: (owner) => servers[owner] });
  return { mgr, tasks, stops, replies };
}

test("remote_send: servers 未設定の session は従来どおり（server 省略は先頭、明示指定はどれでも）", async () => {
  const { mgr, tasks } = setup({});
  assert.equal((await mgr.send({ owner: "pm1", goal: "a" })).server, "srv-lenovo-a");
  assert.equal((await mgr.send({ owner: "pm1", goal: "b", server: "mac200" })).server, "srv-mac");
  assert.deepEqual(tasks.map((t) => t.peer), ["p-la", "p-mac"]);
});

test("remote_send: 明示指定が servers の範囲外ならエラー「この session の servers に無い」で何も送らず記録も作らない。範囲内なら送れる", async () => {
  const { mgr, tasks } = setup({ pm1: ["mac200"] });
  await assert.rejects(mgr.send({ owner: "pm1", goal: "a", server: "srv-lenovo-a" }), /この session の servers に無い.*lenovo.*srv-lenovo-a.*session=pm1.*servers=\[mac200\]/);
  await assert.rejects(mgr.send({ owner: "pm1", goal: "a", server: "p-lb" }), /この session の servers に無い/);
  assert.equal(tasks.length, 0);
  assert.equal(mgr.list().length, 0);
  assert.equal((await mgr.send({ owner: "pm1", goal: "ok", server: "srv-mac" })).server, "srv-mac");
  assert.equal(tasks.length, 1);
});

test("remote_send: server 省略時の既定は範囲内の先頭に限る（発見の先頭が範囲外でも範囲内を選ぶ）。範囲内に server が居なければエラー", async () => {
  const { mgr, tasks } = setup({ pm1: ["mac200"], pm2: ["nothere"] });
  const r = await mgr.send({ owner: "pm1", goal: "a" });
  assert.equal(r.server, "srv-mac");
  assert.equal(tasks[0].peer, "p-mac");
  await assert.rejects(mgr.send({ owner: "pm2", goal: "a" }), /この session の servers に無い: 使える server が無い.*servers=\[nothere\]/);
});

test("servers: server_id なら同じ host の 2 台のうち 1 台だけを範囲にできる。host 名なら 2 台とも範囲（host 名指定は曖昧エラーのまま）", async () => {
  const { mgr, tasks } = setup({ pm1: ["srv-lenovo-b"], pm2: ["lenovo"] });
  await assert.rejects(mgr.send({ owner: "pm1", goal: "a", server: "srv-lenovo-a" }), /この session の servers に無い/);
  assert.equal((await mgr.send({ owner: "pm1", goal: "a", server: "srv-lenovo-b" })).server, "srv-lenovo-b");
  assert.equal((await mgr.send({ owner: "pm1", goal: "d" })).server, "srv-lenovo-b", "省略時の既定は範囲内の 1 台");
  await assert.rejects(mgr.send({ owner: "pm2", goal: "a", server: "lenovo" }), /曖昧/);
  assert.equal((await mgr.send({ owner: "pm2", goal: "a", server: "srv-lenovo-a" })).server, "srv-lenovo-a");
  assert.deepEqual(tasks.map((t) => t.peer), ["p-lb", "p-lb", "p-la"]);
});

test("servers: 空配列は「どの server も使わない」。明示指定も省略も範囲外エラー", async () => {
  const { mgr, tasks } = setup({ pm1: [] });
  await assert.rejects(mgr.send({ owner: "pm1", goal: "a" }), /この session の servers に無い.*空 = どの server も使わない/);
  await assert.rejects(mgr.send({ owner: "pm1", goal: "a", server: "mac200" }), /この session の servers に無い/);
  assert.equal(tasks.length, 0);
});

test("remote_delete / worker_reply: server 省略は範囲内の cap だけが候補、明示指定が範囲外ならエラー（stop_cap も worker_reply も送らない）。list は範囲に関わらずその session の cap を出す", async () => {
  const servers: Record<string, string[] | undefined> = {};
  const { mgr, stops, replies } = setup(servers);
  await mgr.send({ owner: "pm1", goal: "a", server: "srv-mac" });
  await mgr.send({ owner: "pm1", goal: "b", server: "srv-lenovo-a" });
  servers.pm1 = ["mac200"];
  assert.equal(mgr.list({ owner: "pm1" }).length, 2, "範囲を後で狭めても、その session の cap は list に出る");
  await assert.rejects(mgr.delete({ owner: "pm1", server: "srv-lenovo-a" }), /この session の servers に無い/);
  await assert.rejects(mgr.workerReply({ owner: "pm1", server: "lenovo", worker_id: "w-1", text: "x" }), /この session の servers に無い/);
  assert.equal(stops.length, 0);
  assert.equal(replies.length, 0);
  // 省略: 範囲内（mac）の cap だけが候補なので 1 件に決まる
  const wr = await mgr.workerReply({ owner: "pm1", worker_id: "w-1", text: "ok" });
  assert.equal(wr.server, "srv-mac");
  const del = await mgr.delete({ owner: "pm1" });
  assert.equal(del.deleted, true);
  assert.deepEqual(stops.map((s) => s.peer), ["p-mac"]);
  // 範囲内の cap がもう無い: 省略でも範囲外の cap を消さない
  await assert.rejects(mgr.delete({ owner: "pm1" }), /この session の servers に無い/);
  assert.equal(mgr.list({ owner: "pm1" }).length, 1);
  // 範囲を外せば消せる
  servers.pm1 = undefined;
  assert.equal((await mgr.delete({ owner: "pm1" })).deleted, true);
});

test("owner の無い呼び出し（desktop の center_call など）は servers の影響を受けない", async () => {
  const { mgr, replies } = setup({ pm1: [] });
  await mgr.send({ owner: "pm2", goal: "a", server: "srv-mac" });
  const r = await mgr.workerReply({ worker_id: "w-1", text: "x" });
  assert.equal(r.server, "srv-mac");
  assert.equal(replies.length, 1);
});

test("servers=[片方の server_id]: host 名の指定は範囲内の 1 台に届く。省略も範囲内の 1 台。両方の server_id を範囲にして host 名で指すと曖昧エラー", async () => {
  const { mgr, tasks } = setup({ pm1: ["srv-lenovo-b"], pm2: ["srv-lenovo-a", "srv-lenovo-b"], pm3: ["srv-mac"] });
  assert.equal((await mgr.send({ owner: "pm1", goal: "a", server: "lenovo" })).server, "srv-lenovo-b");
  assert.equal((await mgr.send({ owner: "pm1", goal: "b" })).server, "srv-lenovo-b");
  await assert.rejects(mgr.send({ owner: "pm2", goal: "c", server: "lenovo" }), /曖昧/);
  await assert.rejects(mgr.send({ owner: "pm3", goal: "d", server: "lenovo" }), /この session の servers に無い/);
  assert.deepEqual(tasks.map((t) => t.peer), ["p-lb", "p-lb"]);
});
