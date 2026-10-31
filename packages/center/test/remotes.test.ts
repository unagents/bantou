import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { createActivityStore, type ActivityStore } from "../src/activity.js";
import { createRemoteManager, type RemoteRecord } from "../src/remotes.js";
import type { ServerLink, ServerPeer } from "../src/server-link.js";
import { createJsonListStore } from "../src/store.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "center-rem-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const peerA: ServerPeer = { id: "id-a", name: "bantou-server", version: "1.1.0" };
const peerB: ServerPeer = { id: "id-b", name: "other" };

function setup(over: Partial<ServerLink> = {}, activity?: ActivityStore) {
  const kicks: { peer: ServerPeer; cmd: Record<string, unknown>; resolve: (r: unknown) => void }[] = [];
  const stops: { peer: ServerPeer; cmd: unknown }[] = [];
  let peers = [peerA, peerB];
  const link = {
    peers: async () => peers,
    selectPeer: async (sel?: string) => {
      if (sel === undefined) return peers[0];
      const h = peers.find((p) => p.id === sel) ?? peers.find((p) => p.name === sel);
      if (!h) throw new Error(`server が見つからない: ${sel}`);
      return h;
    },
    kickCapOn: (peer: ServerPeer, cmd: Record<string, unknown>) =>
      new Promise((resolve) => kicks.push({ peer, cmd, resolve })),
    stopCapOn: async (peer: ServerPeer, cmd: unknown) => {
      stops.push({ peer, cmd });
      return { bantou: 1, type: "stop_result", ok: true, cap_id: (cmd as { cap_id: string }).cap_id, stopped: true };
    },
    ...over,
  } as unknown as ServerLink;
  const store = createJsonListStore<RemoteRecord>(join(dir, "remotes.json"), () => {});
  let n = 0;
  const mgr = createRemoteManager({ link, store, log: () => {}, newId: () => `r-${++n}`, ...(activity ? { activity } : {}) });
  return { mgr, kicks, stops, store, setPeers: (p: ServerPeer[]) => (peers = p) };
}
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 10));

test("create: 返信を待たず running で返り、kick_cap を先頭 server に送る", async () => {
  const { mgr, kicks } = setup();
  const r = await mgr.create({ owner: "pm1", prompt: "go", repo: "https://x/y.git", branch: "main" });
  assert.deepEqual({ id: r.remote_id, server: r.server, state: r.state, owner: r.owner }, { id: "r-1", server: "id-a", state: "running", owner: "pm1" });
  assert.equal(kicks.length, 1);
  assert.equal(kicks[0].peer.id, "id-a");
  assert.deepEqual(kicks[0].cmd, { cap_id: "r-1", prompt: "go", repo: "https://x/y.git", branch: "main", reason: "remote_create owner=pm1" });
  const saved = JSON.parse(await readFile(join(dir, "remotes.json"), "utf8")) as RemoteRecord[];
  assert.equal(saved[0].state, "running");
});

test("create: server は peer id か名前で指定でき、見つからなければ記録を作らず失敗", async () => {
  const { mgr, kicks } = setup();
  assert.equal((await mgr.create({ owner: "o", prompt: "p", server: "id-b" })).serverName, "other");
  assert.equal((await mgr.create({ owner: "o", prompt: "p", server: "bantou-server" })).server, "id-a");
  await assert.rejects(mgr.create({ owner: "o", prompt: "p", server: "zzz" }), /見つからない/);
  assert.equal(mgr.list().length, 2);
  assert.equal(kicks.length, 2);
});

test("返信で state が done / failed に更新され、結果が残る", async () => {
  const { mgr, kicks } = setup();
  await mgr.create({ owner: "o", prompt: "p" });
  await mgr.create({ owner: "o", prompt: "p" });
  await mgr.create({ owner: "o", prompt: "p" });
  kicks[0].resolve({ bantou: 1, type: "cap_result", cap_id: "r-1", session_id: "s", ok: true, result_text: "OK!" });
  kicks[1].resolve({ bantou: 1, type: "error", ok: false, message: "boom", command: "kick_cap", cap_id: "r-2" });
  kicks[2].resolve({ bantou: 1, type: "cap_result", cap_id: "r-3", session_id: "s", ok: false, result_text: "", error: "timeout" });
  await tick();
  const by = Object.fromEntries(mgr.list().map((r) => [r.remote_id, r]));
  assert.equal(by["r-1"].state, "done");
  assert.equal(by["r-1"].result, "OK!");
  assert.ok(by["r-1"].finishedAt);
  assert.deepEqual([by["r-2"].state, by["r-2"].error], ["failed", "boom"]);
  assert.deepEqual([by["r-3"].state, by["r-3"].error], ["failed", "timeout"]);
});

test("送信自体の失敗（reject）も failed", async () => {
  const { mgr } = setup({ kickCapOn: async () => { throw new Error("link down"); } });
  await mgr.create({ owner: "o", prompt: "p" });
  await tick();
  assert.deepEqual([mgr.list()[0].state, mgr.list()[0].error], ["failed", "link down"]);
});

test("list: owner で絞れる。返り値の変更は内部に影響しない", async () => {
  const { mgr } = setup();
  await mgr.create({ owner: "a", prompt: "p" });
  await mgr.create({ owner: "b", prompt: "p" });
  assert.deepEqual(mgr.list({ owner: "a" }).map((r) => r.remote_id), ["r-1"]);
  assert.equal(mgr.list().length, 2);
  mgr.list()[0].state = "done";
  assert.equal(mgr.list()[0].state, "running");
});

test("delete: stop_cap を送って記録を外す。外した後の遅れた返信は記録を復活させない", async () => {
  const { mgr, kicks, stops } = setup();
  await mgr.create({ owner: "a", prompt: "p" });
  const r = await mgr.delete({ remote_id: "r-1", owner: "a" });
  assert.deepEqual(r, { remote_id: "r-1", deleted: true, stopped: true });
  assert.deepEqual(stops.map((s) => [s.peer.id, s.cmd]), [["id-a", { cap_id: "r-1" }]]);
  assert.equal(mgr.list().length, 0);
  kicks[0].resolve({ bantou: 1, type: "cap_result", cap_id: "r-1", session_id: "s", ok: false, result_text: "", error: "stop_cap により停止" });
  await tick();
  assert.equal(mgr.list().length, 0);
  assert.deepEqual(JSON.parse(await readFile(join(dir, "remotes.json"), "utf8")), []);
});

test("delete: 別 owner は拒否、未定義は拒否、owner 不明なら通る", async () => {
  const { mgr } = setup();
  await mgr.create({ owner: "a", prompt: "p" });
  await assert.rejects(mgr.delete({ remote_id: "r-1", owner: "b" }), /別の owner/);
  await assert.rejects(mgr.delete({ remote_id: "nope" }), /未定義/);
  assert.equal(mgr.list().length, 1);
  assert.equal((await mgr.delete({ remote_id: "r-1" })).deleted, true);
});

test("delete: server の peer id が変わっていても名前で探して stop を送る。居なければ running は拒否、force で記録だけ消す", async () => {
  const { mgr, stops, setPeers } = setup();
  await mgr.create({ owner: "a", prompt: "p" });
  await mgr.create({ owner: "a", prompt: "p" });
  setPeers([{ id: "id-new", name: "bantou-server" }]);
  await mgr.delete({ remote_id: "r-1" });
  assert.equal(stops[0].peer.id, "id-new");
  setPeers([]);
  await assert.rejects(mgr.delete({ remote_id: "r-2" }), /止められない/);
  assert.equal(mgr.list().length, 1);
  const f = await mgr.delete({ remote_id: "r-2", force: true });
  assert.deepEqual([f.deleted, f.stopped], [true, false]);
  assert.match(f.warning ?? "", /stop_cap を送れなかった/);
});

test("delete: stop が error 返信なら running は拒否。終わった記録は警告付きで消せる", async () => {
  const { mgr, kicks } = setup({
    stopCapOn: async () => ({ bantou: 1, type: "error", ok: false, message: "ng", command: "stop_cap" }),
  } as never);
  await mgr.create({ owner: "a", prompt: "p" });
  await assert.rejects(mgr.delete({ remote_id: "r-1" }), /ng/);
  kicks[0].resolve({ bantou: 1, type: "cap_result", cap_id: "r-1", session_id: "s", ok: true, result_text: "x" });
  await tick();
  const r = await mgr.delete({ remote_id: "r-1" });
  assert.equal(r.deleted, true);
  assert.match(r.warning ?? "", /ng/);
});

test("restore: 保存済みを読み、running は failed（返信を失った）にする", async () => {
  const { mgr, store } = setup();
  const base = { owner: "a", server: "id-a", serverName: "bantou-server", createdAt: "t" };
  await store.save([
    { ...base, remote_id: "r-9", state: "running" },
    { ...base, remote_id: "r-8", state: "done" },
    { ...base, remote_id: "bad id", state: "done" },
  ]);
  await mgr.restore();
  const by = Object.fromEntries(mgr.list().map((r) => [r.remote_id, r]));
  assert.deepEqual(Object.keys(by).sort(), ["r-8", "r-9"]);
  assert.equal(by["r-9"].state, "failed");
  assert.match(by["r-9"].error ?? "", /center 再起動/);
  assert.equal(by["r-8"].state, "done");
});

test("owner 形式が不正なら create は拒否", async () => {
  const { mgr } = setup();
  await assert.rejects(mgr.create({ owner: "a b", prompt: "p" }), /owner/);
});

test("list: activity 通知のある remote には activity が付き、無い remote には付かない。delete で忘れる", async () => {
  let now = 1_000_000;
  const activity = createActivityStore({ now: () => now });
  const { mgr } = setup({}, activity);
  await mgr.create({ owner: "a", prompt: "p" });
  await mgr.create({ owner: "a", prompt: "p" });
  activity.apply({
    bantou: 1, type: "activity", cap_id: "r-1", at: "2026-10-29T00:00:00.000Z",
    agents: [{ kind: "cap", id: "r-1", cap_id: "r-1", state: "running", task: "t", last_activity: null, last_output_at: null, silent_ms: 1000, started_at: null, finished_at: null }],
  });
  now += 2000;
  const [r1, r2] = mgr.list();
  assert.equal(r1!.activity?.agents[0]!.silent_ms, 3000);
  assert.equal(r1!.activity?.received_ms_ago, 2000);
  assert.equal("activity" in r2!, false);
  // 内部の記録には混ざらない（保存されない）
  assert.equal("activity" in (await mgr.list({ owner: "a" }))[1]!, false);
  await mgr.delete({ remote_id: "r-1", owner: "a" });
  assert.equal(activity.get("r-1"), undefined);
});

test("list: activity の store が無ければ activity キーは付かない", async () => {
  const { mgr } = setup();
  await mgr.create({ owner: "a", prompt: "p" });
  assert.equal("activity" in mgr.list()[0]!, false);
});

test("create: 門が断る（protocol の版違い・更新待ち）時は投げ、記録も kick_cap も作らない", async () => {
  const gated: Array<[string, string]> = [];
  const { mgr, kicks } = setup({
    gate: (p: ServerPeer, c: string) => {
      gated.push([p.id, c]);
      return { bantou: 1, type: "error", ok: false, message: "server 更新待ち（0.3.0→0.3.1）。再起動後に再送", code: "updating", retryable: true };
    },
  } as unknown as Partial<ServerLink>);
  await assert.rejects(mgr.create({ owner: "pm1", prompt: "go" }), /更新待ち.*再送/);
  assert.deepEqual(gated, [["id-a", "kick_cap"]]);
  assert.equal(kicks.length, 0);
  assert.deepEqual(mgr.list(), []);
});

test("create: 門が通せば従来どおり記録を作って kick_cap を送る", async () => {
  const { mgr, kicks } = setup({ gate: () => undefined } as unknown as Partial<ServerLink>);
  const r = await mgr.create({ owner: "pm1", prompt: "go" });
  assert.equal(r.state, "running");
  assert.equal(kicks.length, 1);
});
