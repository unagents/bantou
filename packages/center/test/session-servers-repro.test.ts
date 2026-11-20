// 再現用（fix/center-server-scope）: session の servers（使う server の範囲）まわりで、今の develop が望ましい挙動と違う所。
// 下の test は「あるべき挙動」を書いてあり、今は失敗する（実装 worker が直して通す）。
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
  dir = await mkdtemp(join(tmpdir(), "center-srv-repro-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
});

const peerA: ServerPeer = { id: "p-a", name: "bantou-server", hostname: "host-a", server_id: "srv-a", host: "host-a", user: "ua", workspace: "/a" };
const peerB: ServerPeer = { id: "p-b", name: "bantou-server", hostname: "host-b", server_id: "srv-b", host: "host-b", user: "ub", workspace: "/b" };

function setup(servers: Record<string, string[] | undefined>) {
  const peers = [peerA, peerB];
  const stops: string[] = [];
  const link = {
    peers: async () => peers,
    identifiedPeers: async () => peers,
    // 実の selectPeer と同じ形: 見つからない時のエラーに全 peer の候補を並べる（server-link.ts の「候補: …」）
    selectPeer: async (sel?: string) => {
      if (sel === undefined) return peers[0];
      const hit = peers.find((p) => p.server_id === sel || p.id === sel || p.host === sel);
      if (hit) return hit;
      throw new Error(`server が見つからない: ${sel}（候補: ${peers.map((p) => `${p.host}(${p.server_id})`).join(", ")}）`);
    },
    statusOn: async () => ({ bantou: 1, type: "status_result", ok: true, caps: [], workers: [] }),
    taskOn: async () => new Promise(() => {}),
    stopCapOn: async (p: ServerPeer, cmd: { cap_id: string }) => (stops.push(p.id), { bantou: 1, type: "stop_result", ok: true, cap_id: cmd.cap_id, stopped: true, session_cleared: true, previous_session_id: "s-old" }),
  } as unknown as ServerLink;
  const store = createJsonListStore<RemoteRecord>(join(dir, "remotes.json"), () => {});
  const mgr = createRemoteManager({ link, store, log: () => {}, capId: "c-0123456789", serversOf: (owner) => servers[owner] });
  return { mgr, stops };
}

test("症状(4): 範囲外になった古い cap を、その session 自身が remote_id 指定で remote_delete できる（今は「この session の servers に無い」で拒否される）", async () => {
  const servers: Record<string, string[] | undefined> = {};
  const { mgr } = setup(servers);
  const sent = await mgr.send({ owner: "pm1", goal: "a", server: "srv-b" });
  servers.pm1 = ["host-a"]; // 範囲を srv-a だけに狭める。srv-b の cap は範囲外の古い cap になる
  const del = await mgr.delete({ owner: "pm1", remote_id: sent.remote_id, server: "srv-b", force: true });
  assert.equal(del.deleted, true);
  assert.equal(mgr.list({ owner: "pm1" }).length, 0);
});

test("症状(5): server が見つからない時の候補に範囲外の server を並べない（今は link.selectPeer の候補に全 server が出る）", async () => {
  const { mgr } = setup({ pm1: ["host-a"] });
  await assert.rejects(mgr.send({ owner: "pm1", goal: "a", server: "no-such" }), (e: Error) => {
    assert.match(e.message, /見つからない/);
    assert.doesNotMatch(e.message, /host-b|srv-b/, `範囲外の server が候補に出ている: ${e.message}`);
    return true;
  });
});
