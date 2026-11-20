// session の servers（使う server の範囲）を master-cap に見せる件（fix/center-server-scope）。
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createRemoteManager, type RemoteManager, type RemoteRecord } from "../src/remotes.js";
import { createSessionMcpServer } from "../src/server.js";
import type { ServerLink, ServerPeer } from "../src/server-link.js";
import { createJsonListStore } from "../src/store.js";
import { buildSystemInstructions, MASTER_CAP_ROLE } from "../src/system-instructions.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "center-srv-scope-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
});

const peerA: ServerPeer = { id: "p-a", name: "bantou-server", hostname: "host-a", server_id: "srv-a", host: "host-a", user: "ua", workspace: "/a" };
const peerB: ServerPeer = { id: "p-b", name: "bantou-server", hostname: "host-b", server_id: "srv-b", host: "host-b", user: "ub", workspace: "/b" };

function setup(servers: Record<string, string[] | undefined>) {
  const peers = [peerA, peerB];
  const tasks: string[] = [];
  const stops: string[] = [];
  const link = {
    peers: async () => peers,
    identifiedPeers: async () => peers,
    selectPeer: async (sel?: string) => {
      if (sel === undefined) return peers[0];
      const hit = peers.find((p) => p.server_id === sel || p.id === sel || p.host === sel);
      if (hit) return hit;
      throw new Error(`server が見つからない: ${sel}（候補: ${peers.map((p) => `${p.host}(${p.server_id})`).join(", ")}）`);
    },
    statusOn: async () => ({ bantou: 1, type: "status_result", ok: true, caps: [], workers: [] }),
    taskOn: async (p: ServerPeer) => (tasks.push(p.id), new Promise(() => {})),
    stopCapOn: async (p: ServerPeer, cmd: { cap_id: string }) => (stops.push(p.id), { bantou: 1, type: "stop_result", ok: true, cap_id: cmd.cap_id, stopped: true, session_cleared: true, previous_session_id: "s-old" }),
  } as unknown as ServerLink;
  const store = createJsonListStore<RemoteRecord>(join(dir, "remotes.json"), () => {});
  const mgr = createRemoteManager({ link, store, log: () => {}, capId: "c-0123456789", serversOf: (owner) => servers[owner] });
  return { mgr, tasks, stops };
}

test("範囲が 1 つの session は server を省いた remote_send が範囲内の server に届く（先頭の server が範囲外でも曖昧にならない）", async () => {
  const { mgr, tasks } = setup({ pm1: ["host-b"] });
  const r = await mgr.send({ owner: "pm1", goal: "a" });
  assert.equal(r.server, "srv-b");
  assert.deepEqual(tasks, ["p-b"]);
});

test("remote_list（manager）: 範囲外の自分の cap は既定で出ない。includeOutOfScope で出る。他の session の cap は常に出ない", async () => {
  const servers: Record<string, string[] | undefined> = {};
  const { mgr } = setup(servers);
  await mgr.send({ owner: "pm1", goal: "a", server: "srv-a" });
  await mgr.send({ owner: "pm1", goal: "b", server: "srv-b" });
  await mgr.send({ owner: "pm2", goal: "c", server: "srv-b" });
  servers.pm1 = ["host-a"];
  assert.deepEqual(mgr.list({ owner: "pm1" }).map((v) => v.server), ["srv-a"]);
  const all = mgr.list({ owner: "pm1", includeOutOfScope: true });
  assert.deepEqual(all.map((v) => v.server).sort(), ["srv-a", "srv-b"]);
  assert.ok(all.every((v) => v.session === "pm1"));
  assert.deepEqual(mgr.scopeOf("pm1"), { servers: ["host-a"], out_of_scope: 1 });
  assert.deepEqual(mgr.scopeOf("pm3"), { servers: undefined, out_of_scope: 0 });
});

test("remote_delete: 範囲外の自分の古い cap は remote_id 明示で消せる。remote_id 省略では消せない。他の session の cap は消せない・stop も送らない", async () => {
  const servers: Record<string, string[] | undefined> = {};
  const { mgr, stops } = setup(servers);
  const mine = await mgr.send({ owner: "pm1", goal: "a", server: "srv-b" });
  const other = await mgr.send({ owner: "pm2", goal: "b", server: "srv-b" });
  servers.pm1 = ["host-a"];
  await assert.rejects(mgr.delete({ owner: "pm1" }), /この session の servers に無い/);
  assert.equal(stops.length, 0);
  await assert.rejects(mgr.delete({ owner: "pm1", remote_id: other.remote_id, server: "srv-b", force: true }), /未定義の remote/);
  assert.equal(stops.length, 0);
  assert.equal((await mgr.delete({ owner: "pm1", remote_id: mine.remote_id })).deleted, true);
  assert.deepEqual(stops, ["p-b"]);
  assert.equal(mgr.list({ owner: "pm2", includeOutOfScope: true }).length, 1);
});

test("server が見つからない時の候補は範囲内の server だけ（範囲外の host / server_id を出さない）", async () => {
  const { mgr } = setup({ pm1: ["host-a"] });
  await assert.rejects(mgr.send({ owner: "pm1", goal: "a", server: "nope" }), (e: Error) => {
    assert.match(e.message, /見つからない: nope/);
    assert.match(e.message, /host-a\(srv-a\)/);
    assert.doesNotMatch(e.message, /host-b|srv-b/);
    return true;
  });
});

test("指示文: 範囲の指定がある session だけ「使う server の範囲」の節が出る（範囲・置き場・remote_delete の片付け）。指定が無ければ出ない。部品の version は 6", () => {
  const on = buildSystemInstructions({ session: "s", servers: ["host-a", "srv-x"] });
  assert.match(on, /\[使う server の範囲\]/);
  assert.match(on, /host-a, srv-x/);
  assert.match(on, /settings\.servers/);
  assert.match(on, /remote_id を指して remote_delete/);
  assert.match(buildSystemInstructions({ session: "s", servers: [] }), /使える server は無い/);
  assert.doesNotMatch(buildSystemInstructions({ session: "s" }), /使う server の範囲\]/);
  assert.equal(MASTER_CAP_ROLE.version, 6);
});

async function sessionClient(remotes: Partial<RemoteManager>) {
  const s = createSessionMcpServer({ remotes: remotes as RemoteManager, owner: "pm1" });
  const [c, st] = InMemoryTransport.createLinkedPair();
  const cl = new Client({ name: "ts", version: "0" });
  await Promise.all([s.connect(st), cl.connect(c)]);
  return cl;
}
const body = (r: unknown): unknown => JSON.parse((r as { content: { text: string }[] }).content[0]!.text);

test("remote_list（道具）: 範囲の指定がある時は先頭に scope を出し、include_out_of_scope を manager へ渡す。指定が無ければ scope を付けない", async () => {
  const calls: unknown[] = [];
  let scope: { servers: string[] | undefined; out_of_scope: number } = { servers: ["host-a"], out_of_scope: 2 };
  const cl = await sessionClient({ list: (f: unknown) => (calls.push(f), []), scopeOf: () => scope });
  const a = body(await cl.callTool({ name: "remote_list", arguments: {} })) as { scope: { servers: string[]; out_of_scope_caps: number; note: string } }[];
  assert.deepEqual(a[0]!.scope.servers, ["host-a"]);
  assert.equal(a[0]!.scope.out_of_scope_caps, 2);
  assert.match(a[0]!.scope.note, /include_out_of_scope/);
  await cl.callTool({ name: "remote_list", arguments: { include_out_of_scope: true } });
  assert.deepEqual(calls, [{ owner: "pm1" }, { owner: "pm1", includeOutOfScope: true }]);
  scope = { servers: undefined, out_of_scope: 0 };
  assert.deepEqual(body(await cl.callTool({ name: "remote_list", arguments: {} })), []);
  const tools = (await cl.listTools()).tools;
  for (const n of ["remote_list", "remote_send", "remote_delete", "worker_reply"]) assert.match(tools.find((t) => t.name === n)!.description ?? "", /settings\.servers|範囲/, n);
  await cl.close();
});
