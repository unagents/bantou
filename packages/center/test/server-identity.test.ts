import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { MESSENGER_PROTOCOL, parseServerReply } from "@agent-hand/bantou-protocol";
import { parseConfig } from "../src/config.js";
import { createRemoteManager, type RemoteRecord } from "../src/remotes.js";
import { DUP_RECHECK_MS, IDENTIFY_RETRY_MS, createServerLink, matchServerPeers, type LinkClient, type LinkInbound, type LinkMeta, type LinkPeer, type ServerLink, type ServerPeer } from "../src/server-link.js";
import { backupFileOnce, createJsonListStore } from "../src/store.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "center-sid-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
});

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 15));

// -- server-link: 識別の学習 / identifiedPeers / selectPeer --

class FakeClient implements LinkClient {
  sent: Array<{ to: string; msg: Record<string, unknown> }> = [];
  peers: LinkPeer[] = [];
  handler: Parameters<LinkClient["onMessage"]>[0] = () => {};
  peer = { id: "center-1" };
  /** hello に答える peer id → 返信の元（識別つき / 識別なし / error）。無い peer は答えない。 */
  helloReplies = new Map<string, Record<string, unknown>>();
  async connect(): Promise<void> {}
  async close(): Promise<void> {}
  async send(to: string, text: string, _d?: "pull" | "push", meta?: LinkMeta): Promise<unknown> {
    if (!meta) return {};
    const msg = JSON.parse(text) as Record<string, unknown>;
    this.sent.push({ to, msg });
    const reply = msg.type === "hello" ? this.helloReplies.get(to) : undefined;
    if (reply) setImmediate(() => void this.handler({ from_id: to, from_name: "bantou-server", text: JSON.stringify(reply), meta: { protocol: "bantou", version: MESSENGER_PROTOCOL.version } }));
    return {};
  }
  async listPeers(): Promise<LinkPeer[]> {
    return this.peers;
  }
  onMessage(h: (m: LinkInbound) => void | Promise<void>): () => void {
    this.handler = h;
    return () => {};
  }
}

const lp = (id: string, hostname = "h"): LinkPeer => ({ id, name: "bantou-server", hostname, protocols: [{ name: "bantou", version: MESSENGER_PROTOCOL.version }] });
const hello = (extra: Record<string, unknown> = {}) => ({
  bantou: 1, type: "hello_result", ok: true, server_version: "0.1.41", protocol_version: MESSENGER_PROTOCOL.version, update: null, last_update: null, ...extra,
});
const idOf = (n: string, host: string, user = "u", workspace = "/w") => ({ server_id: n, host, user, workspace });

function linkWith(client: FakeClient, now?: () => number) {
  return createServerLink({ config: parseConfig({}, "/x/c.json"), log: () => {}, clientFactory: () => client, identifyTimeoutMs: 40, ...(now ? { now } : {}) });
}

test("旧 server（server_id 無しの hello_result）は識別なしの peer として扱え、hello は再送しない。新 server は server_id/host/user/workspace が peers に載る", async () => {
  const c = new FakeClient();
  c.peers = [lp("old-1"), lp("new-1", "lenovo")];
  c.helloReplies.set("old-1", hello());
  c.helloReplies.set("new-1", hello(idOf("srv-aaaaaaaaaa", "lenovo", "wgy", "/srv/a")));
  const link = linkWith(c);
  const ps = await link.identifiedPeers!();
  const old = ps.find((p) => p.id === "old-1")!;
  const nw = ps.find((p) => p.id === "new-1")!;
  assert.equal(old.server_id, undefined);
  assert.deepEqual([nw.server_id, nw.host, nw.user, nw.workspace], ["srv-aaaaaaaaaa", "lenovo", "wgy", "/srv/a"]);
  assert.equal(c.sent.filter((s) => s.msg.type === "hello").length, 2);
  await link.identifiedPeers!();
  assert.equal(c.sent.filter((s) => s.msg.type === "hello").length, 2, "識別済み（旧 server の識別なしを含む）へは再送しない");
  await link.close();
});

test("hello を知らない旧 server の error 返信は識別なしとして扱い、再送しない。届かない peer は IDENTIFY_RETRY_MS 後に再試行する", async () => {
  const c = new FakeClient();
  c.peers = [lp("ancient"), lp("mute")];
  c.helloReplies.set("ancient", { bantou: 1, type: "error", ok: false, message: "unknown command", command: "hello" });
  let t = 1_000_000;
  const link = linkWith(c, () => t);
  await link.identifiedPeers!();
  assert.equal(c.sent.filter((s) => s.msg.type === "hello").length, 2);
  await link.identifiedPeers!();
  assert.equal(c.sent.filter((s) => s.msg.type === "hello").length, 2, "mute は直後には再送しない");
  t += IDENTIFY_RETRY_MS;
  await link.identifiedPeers!();
  assert.deepEqual(c.sent.filter((s) => s.msg.type === "hello").map((s) => s.to), ["ancient", "mute", "mute"]);
  await link.close();
});

test("server が再登録して peer id が変わっても、server_id は同じ server として引き継がれ、旧 peer id の識別は整理される", async () => {
  const c = new FakeClient();
  c.peers = [lp("p-1", "lenovo")];
  c.helloReplies.set("p-1", hello(idOf("srv-bbbbbbbbbb", "lenovo")));
  c.helloReplies.set("p-2", hello(idOf("srv-bbbbbbbbbb", "lenovo")));
  const link = linkWith(c);
  assert.equal((await link.identifiedPeers!())[0].server_id, "srv-bbbbbbbbbb");
  assert.equal(link.identityOf!("p-1")?.server_id, "srv-bbbbbbbbbb");
  c.peers = [lp("p-2", "lenovo")]; // 再登録
  const after = await link.identifiedPeers!();
  assert.deepEqual([after[0].id, after[0].server_id], ["p-2", "srv-bbbbbbbbbb"]);
  assert.equal(link.identityOf!("p-1"), undefined);
  await link.close();
});

test("selectPeer: server_id / peer id / host 名のどれでも指せる。同じ host に 2 つなら曖昧エラー（user と workspace 付き）で誤送信しない", async () => {
  const c = new FakeClient();
  c.peers = [lp("mx1ekubv", "lenovo"), lp("83caasod", "lenovo"), lp("zz", "mac")];
  c.helloReplies.set("mx1ekubv", hello(idOf("srv-1111111111", "lenovo", "alice", "/home/alice/ws")));
  c.helloReplies.set("83caasod", hello(idOf("srv-2222222222", "lenovo", "bob", "/home/bob/ws")));
  c.helloReplies.set("zz", hello(idOf("srv-3333333333", "mac", "carol", "/Users/carol/ws")));
  const link = linkWith(c);
  assert.equal((await link.selectPeer("srv-2222222222")).id, "83caasod");
  assert.equal((await link.selectPeer("mx1ekubv")).server_id, "srv-1111111111");
  assert.equal((await link.selectPeer("mac")).id, "zz");
  await assert.rejects(link.selectPeer("lenovo"), (e: Error) => /曖昧/.test(e.message) && /alice/.test(e.message) && /\/home\/alice\/ws/.test(e.message) && /bob/.test(e.message) && /srv-2222222222/.test(e.message));
  await assert.rejects(link.selectPeer("bantou-server"), /曖昧/);
  await assert.rejects(link.selectPeer("nope"), /見つからない/);
  await link.close();
});

test("matchServerPeers: server_id → peer id → host → 名前の順。host は大文字小文字を区別しない", () => {
  const ps: ServerPeer[] = [
    { id: "a", name: "bantou-server", hostname: "Lenovo", server_id: "srv-x" },
    { id: "srv-x", name: "n", hostname: "h2" },
  ];
  assert.deepEqual(matchServerPeers(ps, "srv-x").map((p) => p.id), ["a"]);
  assert.deepEqual(matchServerPeers(ps, "lenovo").map((p) => p.id), ["a"]);
  assert.deepEqual(matchServerPeers(ps, "bantou-server").map((p) => p.id), ["a"]);
});

test("protocol 互換: 新 server の返信（識別つき）も、未知の追加フィールドも parseServerReply を通る。旧 server の返信（識別なし）も通る。不正な server_id は通らない", () => {
  assert.equal(parseServerReply(JSON.stringify(hello(idOf("srv-aaaaaaaaaa", "h")))).type, "hello_result");
  assert.equal(parseServerReply(JSON.stringify(hello({ future_field: 1 })))?.type, "hello_result");
  assert.equal(parseServerReply(JSON.stringify(hello()))?.type, "hello_result");
  assert.equal(parseServerReply(JSON.stringify(hello({ server_id: "bad id!" }))), undefined);
  assert.equal(parseServerReply(JSON.stringify(hello({ host: 5 }))), undefined);
});

// -- remotes: server_id での記録 / 指定 / 移行 / 整理 --

const SID_A = "srv-aaaaaaaaaa";
const SID_B = "srv-bbbbbbbbbb";
const CENTER = "c-0123456789";
const CAP = `${CENTER}-pm1`;

const peerOf = (id: string, over: Partial<ServerPeer> = {}): ServerPeer => ({ id, name: "bantou-server", hostname: "lenovo", ...over });
const newA = (id = "pa-1"): ServerPeer => peerOf(id, { server_id: SID_A, host: "lenovo", user: "alice", workspace: "/home/alice/ws" });
const newB = (id = "pb-1"): ServerPeer => peerOf(id, { server_id: SID_B, host: "lenovo", user: "bob", workspace: "/home/bob/ws" });

function setup(initial: ServerPeer[], extra: Partial<Parameters<typeof createRemoteManager>[0]> = {}) {
  let peers = initial;
  let failDiscovery = false;
  const discover = async (): Promise<ServerPeer[]> => {
    if (failDiscovery) throw new Error("broker down");
    return peers;
  };
  const calls: Array<{ kind: string; peer: string }> = [];
  const logs: string[] = [];
  const caps = new Map<string, string[]>();
  const link = {
    peers: discover,
    identifiedPeers: discover,
    identityOf: (id: string) => peers.find((p) => p.id === id),
    selectPeer: async (sel?: string) => {
      if (sel === undefined) return peers[0];
      const hits = matchServerPeers(peers, sel);
      if (hits.length === 0) throw new Error(`server が見つからない: ${sel}`);
      if (hits.length > 1) throw new Error(`server の指定が曖昧: ${sel} ${hits.map((p) => `${p.host}(${p.server_id}) user=${p.user} workspace=${p.workspace}`).join(" / ")}`);
      return hits[0];
    },
    statusOn: async (peer: ServerPeer) => {
      calls.push({ kind: "status", peer: peer.id });
      return { bantou: 1, type: "status_result", ok: true, caps: (caps.get(peer.server_id ?? peer.id) ?? []).map((id) => ({ kind: "cap", id })), workers: [] };
    },
    taskOn: (peer: ServerPeer, cmd: Record<string, unknown>) => {
      calls.push({ kind: "task", peer: peer.id });
      caps.set(peer.server_id ?? peer.id, [...new Set([...(caps.get(peer.server_id ?? peer.id) ?? []), cmd.cap_id as string])]);
      return new Promise(() => {});
    },
    stopCapOn: async (peer: ServerPeer, cmd: { cap_id: string }) => {
      calls.push({ kind: "stop_cap", peer: peer.id });
      return { bantou: 1, type: "stop_result", ok: true, cap_id: cmd.cap_id, stopped: true, session_cleared: true, previous_session_id: "s-old" };
    },
  } as unknown as ServerLink;
  const store = createJsonListStore<RemoteRecord>(join(dir, "remotes.json"), () => {});
  const mgr = createRemoteManager({ link, store, log: (m) => logs.push(m), capId: CENTER, graceMs: 60, pollMs: 40, ...extra });
  return { mgr, calls, logs, store, setPeers: (p: ServerPeer[]) => (peers = p), setFail: (f: boolean) => (failDiscovery = f) };
}

const readRecords = async (): Promise<RemoteRecord[]> => JSON.parse(await readFile(join(dir, "remotes.json"), "utf8")) as RemoteRecord[];

test("send: 記録は server_id で持ち、peer id は今の到達先として保存する。host 名が主で server_id が添わる", async () => {
  const { mgr } = setup([newA()]);
  const r = await mgr.send({ owner: "pm1", goal: "go" });
  assert.deepEqual([r.server, r.server_id, r.peer, r.host], [SID_A, SID_A, "pa-1", "lenovo"]);
  const [rec] = await readRecords();
  assert.deepEqual([rec.server, rec.server_id, rec.peer, rec.serverHost, rec.serverUser, rec.serverWorkspace], [SID_A, SID_A, "pa-1", "lenovo", "alice", "/home/alice/ws"]);
  assert.equal(mgr.list()[0].server_label, `lenovo(${SID_A})`);
});

test("peer id が変わっても同じ server として扱う: 記録は 1 件のまま peer だけ更新され、同じ cap への指示になる（cap が引き継がれる）", async () => {
  const { mgr, setPeers, calls } = setup([newA("pa-1")]);
  const first = await mgr.send({ owner: "pm1", goal: "one" });
  setPeers([newA("pa-2")]); // 再登録
  const second = await mgr.send({ owner: "pm1", goal: "two" });
  assert.equal(second.remote_id, first.remote_id);
  assert.equal(second.created, false, "cap は引き継がれて既存扱い");
  const recs = await readRecords();
  assert.equal(recs.length, 1);
  assert.deepEqual([recs[0].server, recs[0].peer], [SID_A, "pa-2"]);
  assert.deepEqual(calls.filter((c) => c.kind === "task").map((c) => c.peer), ["pa-1", "pa-2"]);
});

test("server 引数: server_id / host 名 / peer id のどれでも同じ server を指す。曖昧な host 名は誤送信せず候補を user と workspace 付きで返す", async () => {
  const { mgr, calls } = setup([newA(), newB(), peerOf("pm", { server_id: "srv-cccccccccc", host: "mac", hostname: "mac", user: "carol", workspace: "/m" })]);
  for (const sel of [SID_A, "pa-1"]) {
    const r = await mgr.send({ owner: "pm1", goal: "g", server: sel });
    assert.equal(r.server, SID_A, sel);
  }
  const m = await mgr.send({ owner: "pm1", goal: "g", server: "mac" });
  assert.equal(m.server, "srv-cccccccccc");
  const before = calls.length;
  await assert.rejects(mgr.send({ owner: "pm1", goal: "g", server: "lenovo" }), (e: Error) => /曖昧/.test(e.message) && /alice/.test(e.message) && /bob/.test(e.message) && /\/home\/bob\/ws/.test(e.message));
  assert.equal(calls.length, before, "曖昧なら server に何も送らない");
});

test("remote_delete / worker_reply の server 引数も server_id・peer id・host 名で指せ、server が見えなくても記録から指せる。同じ host の 2 server に cap があると host 名は曖昧エラー", async () => {
  const { mgr, setPeers, calls } = setup([newA(), newB()]);
  await mgr.send({ owner: "pm1", goal: "a", server: SID_A });
  await mgr.send({ owner: "pm1", goal: "b", server: SID_B });
  await assert.rejects(mgr.delete({ owner: "pm1", remote_id: CAP, server: "lenovo" }), (e: Error) => /曖昧/.test(e.message) && /alice/.test(e.message) && /bob/.test(e.message));
  await assert.rejects(mgr.delete({ owner: "pm1", remote_id: CAP }), /複数の server/);
  assert.equal(calls.filter((c) => c.kind === "stop_cap").length, 0);
  // server_id で指す（今見えなくても記録で指せる → 見えなければ stop_cap は送れず force が要る）
  setPeers([newB()]);
  await assert.rejects(mgr.delete({ owner: "pm1", remote_id: CAP, server: SID_A }), /server が見つからない/);
  const d = await mgr.delete({ owner: "pm1", remote_id: CAP, server: SID_A, force: true });
  assert.equal(d.deleted, true);
  // peer id で指す
  const d2 = await mgr.delete({ owner: "pm1", remote_id: CAP, server: "pb-1" });
  assert.deepEqual([d2.deleted, d2.stopped], [true, true]);
  assert.equal(mgr.list().length, 0);
});

test("通知（activity など）の送信元 peer id が変わっても、識別（server_id）が同じなら同じ記録に届く。別の server_id からは取り違えない", async () => {
  const { mgr, setPeers } = setup([newA("pa-1")]);
  await mgr.send({ owner: "pm1", goal: "a" });
  setPeers([newA("pa-9")]);
  mgr.onActivity(CAP, "pa-9");
  assert.equal(mgr.list()[0].peer, "pa-9");
  setPeers([newA("pa-9"), newB("pb-5")]);
  mgr.onActivity(CAP, "pb-5");
  assert.equal(mgr.list()[0].peer, "pa-9", "別の server からの通知で到達先を書き換えない");
});

// -- 旧形式の移行 --

const legacy = (over: Record<string, unknown> = {}) => ({
  remote_id: CAP, session: "pm1", server: "old-peer", serverName: "bantou-server", serverHost: "lenovo", state: "done", createdAt: "2026-11-03T00:00:00.000Z", pending: [], ...over,
});
const backupOf = (path: string) => backupFileOnce(path, ".pre-server-id.bak");

test("移行: 旧形式（peer id のみ）の記録が peer id 一致の server の hello で server_id に引き継がれる。元の remotes.json は退避され、再実行しても同じ結果（冪等）で退避は上書きしない", async () => {
  const raw = JSON.stringify([legacy({ server: "pa-1" })]);
  await writeFile(join(dir, "remotes.json"), raw);
  const path = join(dir, "remotes.json");
  const { mgr, calls } = setup([newA("pa-1"), newB("pb-1")], { backup: () => backupOf(path).then(() => undefined) });
  await mgr.restore();
  await tick();
  const [rec] = await readRecords();
  assert.deepEqual([rec.server, rec.server_id, rec.peer, rec.serverUser], [SID_A, SID_A, "pa-1", "alice"]);
  assert.equal(await readFile(`${path}.pre-server-id.bak`, "utf8"), raw);
  assert.equal(calls.filter((c) => c.kind === "stop_cap").length, 0);
  // 2 回目: 同じ内容のまま。退避は最初のものを守る
  const after1 = await readFile(path, "utf8");
  const second = setup([newA("pa-1"), newB("pb-1")], { backup: () => backupOf(path).then(() => undefined) });
  await second.mgr.restore();
  await tick();
  const norm = (s: string) => (JSON.parse(s) as RemoteRecord[]).map(({ peer_seen_at: _s, ...r }) => r);
  assert.deepEqual(norm(await readFile(path, "utf8")), norm(after1));
  assert.equal(await readFile(`${path}.pre-server-id.bak`, "utf8"), raw);
});

test("移行: 対応する server が見えない旧記録は peer id のまま残り（unknown を悪化させない）、その server が hello を返した時（findPeer）に server_id へ引き継がれる", async () => {
  await writeFile(join(dir, "remotes.json"), JSON.stringify([legacy({ server: "pa-1", state: "running", pending: [{ at: "2026-11-03T00:00:00.000Z", owner: "pm1", prompt: "p" }] })]));
  const { mgr, setPeers } = setup([]);
  await mgr.restore();
  const [kept] = await readRecords();
  assert.deepEqual([kept.server, kept.server_id], ["pa-1", undefined]);
  assert.equal(mgr.list().length, 1);
  setPeers([newA("pa-1")]);
  await mgr.wait({ owner: "pm1", remote_id: CAP, timeoutSec: 1 }).catch(() => undefined);
  await tick();
  const [up] = await readRecords();
  assert.deepEqual([up.server, up.server_id], [SID_A, SID_A]);
});

test("移行: 同じ host に同名の server が 2 つある時、peer id が一致しない旧記録を名前+host だけで引き継がない（取り違え防止）。peer id が一致するなら引き継ぐ", async () => {
  await writeFile(join(dir, "remotes.json"), JSON.stringify([legacy({ server: "gone-peer" })]));
  const { mgr } = setup([newA("pa-1"), newB("pb-1")]);
  await mgr.restore();
  await tick();
  const [rec] = await readRecords();
  assert.deepEqual([rec.server, rec.server_id], ["gone-peer", undefined]);
  // 同名+host が 1 つだけなら、peer id が変わっていても引き継ぐ
  await writeFile(join(dir, "remotes.json"), JSON.stringify([legacy({ server: "gone-peer" })]));
  const one = setup([newA("pa-7")]);
  await one.mgr.restore();
  await tick();
  assert.deepEqual((await readRecords())[0].server_id, SID_A);
});

test("移行: 退避に失敗しても、発見に失敗しても、起動（restore）は止まらず記録は残る", async () => {
  await writeFile(join(dir, "remotes.json"), JSON.stringify([legacy({ server: "pa-1" })]));
  const { mgr, logs } = setup([newA("pa-1")], { backup: async () => { throw new Error("disk full"); } });
  await mgr.restore();
  assert.ok(logs.some((l) => /退避に失敗.*disk full/.test(l)));
  assert.equal(mgr.list().length, 1);
  // 発見に失敗: 旧形式のまま残し、起動は止まらない
  await writeFile(join(dir, "remotes.json"), JSON.stringify([legacy({ server: "pa-1" })]));
  const down = setup([newA("pa-1")]);
  down.setFail(true);
  await down.mgr.restore();
  assert.ok(down.logs.some((l) => /発見に失敗/.test(l)));
  assert.deepEqual(down.mgr.list().map((r) => [r.server, r.server_id]), [["pa-1", undefined]]);
});

test("移行: 壊れた/空の remotes.json でも restore は投げない", async () => {
  await writeFile(join(dir, "remotes.json"), "{not json");
  const { mgr } = setup([newA()]);
  await mgr.restore();
  assert.equal(mgr.list().length, 0);
});

// -- 古い記録の整理 --

test("整理: 同じ server_id・同じ cap の旧 peer id の記録は 1 件にまとめる。server には何も送らない", async () => {
  const base = { remote_id: CAP, session: "pm1", server: SID_A, server_id: SID_A, serverName: "bantou-server", serverHost: "lenovo", state: "done", pending: [] };
  await writeFile(join(dir, "remotes.json"), JSON.stringify([
    { ...base, peer: "pa-old", createdAt: "2026-11-01T00:00:00.000Z" },
    { ...base, peer: "pa-1", createdAt: "2026-11-05T00:00:00.000Z" },
  ]));
  const { mgr, calls } = setup([newA("pa-1")]);
  await mgr.restore();
  await tick();
  const recs = await readRecords();
  assert.equal(recs.length, 1);
  assert.equal(recs[0].peer, "pa-1");
  assert.deepEqual(calls.filter((c) => c.kind === "stop_cap" || c.kind === "task"), []);
});

test("整理: 長く確認できず発見にも居ない到達先（peer）は消す。server_id・host・cap の記録（session × server）は残し、server には何も送らない。使われている記録は消えない", async () => {
  let now = Date.parse("2026-11-10T00:00:00.000Z");
  const { mgr, setPeers, calls } = setup([newA("pa-1")], { now: () => now, peerTtlMs: 3_600_000 });
  await mgr.send({ owner: "pm1", goal: "g", server: SID_A });
  setPeers([]); // server が消えた
  now += 1_800_000;
  assert.deepEqual(await mgr.prune(), { duplicates: 0, peers: 0 }, "TTL 内は消さない");
  now += 3_600_000;
  const before = calls.length;
  assert.deepEqual(await mgr.prune(), { duplicates: 0, peers: 1 });
  const [rec] = mgr.list();
  assert.deepEqual([rec.server, rec.server_id, rec.serverHost, rec.peer, rec.remote_id], [SID_A, SID_A, "lenovo", undefined, CAP]);
  assert.equal(rec.pending.length, 1, "未完了の指示は残る");
  assert.equal(calls.length, before, "整理で server に何も送らない");
  // 発見できる間は消さない（古くても、居るなら到達先は有効）
  setPeers([newA("pa-1")]);
  await mgr.send({ owner: "pm1", goal: "again", server: SID_A });
  now += 10 * 3_600_000;
  assert.deepEqual(await mgr.prune(), { duplicates: 0, peers: 0 });
});

test("整理: 発見に失敗している間は到達先を消さない", async () => {
  let now = Date.parse("2026-11-10T00:00:00.000Z");
  const { mgr, setFail } = setup([newA("pa-1")], { now: () => now, peerTtlMs: 1000 });
  await mgr.send({ owner: "pm1", goal: "g" });
  now += 10_000;
  setFail(true);
  assert.deepEqual(await mgr.prune(), { duplicates: 0, peers: 0 });
  assert.equal(mgr.list()[0].peer, "pa-1");
  setFail(false);
  const { peers } = await mgr.prune();
  assert.equal(peers, 0, "居る peer は消さない");
});

test("表示: 同じ host 名の server が複数ある時だけ server_label に user と workspace が付く", async () => {
  const { mgr } = setup([newA(), newB(), peerOf("pm", { server_id: "srv-cccccccccc", host: "mac", hostname: "mac", user: "carol", workspace: "/m" })]);
  await mgr.send({ owner: "pm1", goal: "g", server: "mac" });
  assert.equal(mgr.list()[0].server_label, "mac(srv-cccccccccc)");
  await mgr.send({ owner: "pm1", goal: "g", server: SID_A });
  await mgr.send({ owner: "pm1", goal: "g", server: SID_B });
  const labels = mgr.list().map((r) => r.server_label).sort();
  assert.deepEqual(labels, [`lenovo(${SID_A}) user=alice workspace=/home/alice/ws`, `lenovo(${SID_B}) user=bob workspace=/home/bob/ws`, "mac(srv-cccccccccc)"].sort());
});

test("backupFileOnce: 元が無ければ何もしない。あれば退避し、2 回目は上書きしない", async () => {
  const p = join(dir, "x.json");
  assert.equal(await backupFileOnce(p, ".bak"), false);
  await writeFile(p, "one");
  assert.equal(await backupFileOnce(p, ".bak"), true);
  await writeFile(p, "two");
  assert.equal(await backupFileOnce(p, ".bak"), false);
  assert.equal(await readFile(`${p}.bak`, "utf8"), "one");
  assert.ok((await stat(`${p}.bak`)).isFile());
});

// -- review 第1回 --

test("review M1: 同じ peer id に別の server_id が現れても、識別が一致する新しい記録に遅延返信が届く。旧記録の peer は外れる", async () => {
  const { mgr, setPeers } = setup([newA("p-1")]);
  await mgr.send({ owner: "pm1", goal: "a" });
  // 同じ peer id が別の server_id を名乗る（workspace の作り直し）
  const SID_D = "srv-dddddddddd";
  setPeers([peerOf("p-1", { server_id: SID_D, host: "lenovo", user: "alice", workspace: "/home/alice/ws2" })]);
  const r = await mgr.send({ owner: "pm1", goal: "b" });
  assert.equal(r.server, SID_D);
  const recs = await readRecords();
  assert.equal(recs.length, 2, "別の server_id なので別の記録");
  const oldRec = recs.find((x) => x.server_id === SID_A)!;
  const newRec = recs.find((x) => x.server_id === SID_D)!;
  assert.equal(oldRec.peer, undefined, "旧記録に peer を残さない");
  assert.equal(newRec.peer, "p-1");
  // 遅延返信は識別が一致する新しい記録へ（peer id 一致の旧記録に当たって弾かれない）
  // 過去の task の遅れた error（待ち中の task_id と違う）は反映される。新しい記録だけに付く
  const late = mgr.applyLateReply({ bantou: 1, type: "error", ok: false, message: "late-boom", task_id: "t-old", cap_id: CAP } as never, "p-1");
  assert.equal(late, true, "遅延返信を新しい記録で受ける");
  assert.match(mgr.list().find((x) => x.server_id === SID_D)?.error ?? mgr.list().find((x) => x.server_id === SID_D)?.result ?? "", /late-boom/);
  assert.doesNotMatch(String(mgr.list().find((x) => x.server_id === SID_A)?.error ?? ""), /late-boom/);
});

test("review L1: 同じ server_id を名乗る peer が live に 2 つなら、selectPeer（省略・server_id・host）は peer id 付きのエラーで送らない。peer id なら通る。識別は揺れない", async () => {
  const c = new FakeClient();
  c.peers = [lp("c-1", "lenovo"), lp("c-2", "lenovo")];
  c.helloReplies.set("c-1", hello(idOf("srv-eeeeeeeeee", "lenovo", "alice", "/home/alice/ws")));
  c.helloReplies.set("c-2", hello(idOf("srv-eeeeeeeeee", "lenovo", "alice", "/mnt/copy/ws")));
  const link = linkWith(c);
  const msg = (e: Error) => /同じ server_id srv-eeeeeeeeee/.test(e.message) && /c-1=/.test(e.message) && /c-2=/.test(e.message) && /\/mnt\/copy\/ws/.test(e.message);
  await assert.rejects(link.selectPeer(), msg);
  await assert.rejects(link.selectPeer("srv-eeeeeeeeee"), msg);
  await assert.rejects(link.selectPeer("lenovo"), msg);
  assert.equal((await link.selectPeer("c-2")).workspace, "/mnt/copy/ws");
  // 互いの識別を捨てて hello を取り直し続けない
  const hellos = c.sent.filter((s) => s.msg.type === "hello").length;
  await link.identifiedPeers!();
  await link.selectPeer("c-1");
  assert.equal(c.sent.filter((s) => s.msg.type === "hello").length, hellos, "hello を再送しない");
  assert.equal(link.identityOf!("c-1")?.workspace, "/home/alice/ws");
  assert.equal(link.identityOf!("c-2")?.workspace, "/mnt/copy/ws");
  await link.close();
});

test("review L1: 記録の server_id を名乗る peer が live に複数いる時、findPeer（remote_delete）はエラーで stop_cap を送らない", async () => {
  const { mgr, setPeers, calls } = setup([newA("pa-1")]);
  await mgr.send({ owner: "pm1", goal: "a" });
  setPeers([newA("pa-1"), peerOf("pa-copy", { server_id: SID_A, host: "lenovo", user: "alice", workspace: "/mnt/copy" })]);
  await assert.rejects(mgr.delete({ owner: "pm1", remote_id: CAP, server: SID_A }), (e: Error) => /同じ server_id/.test(e.message) && /pa-copy=/.test(e.message));
  assert.equal(calls.filter((x) => x.kind === "stop_cap").length, 0);
});

test("review L2: restore で発見に失敗した時は、古い到達先（peer）を消さない", async () => {
  await writeFile(join(dir, "remotes.json"), JSON.stringify([{
    remote_id: CAP, session: "pm1", server: SID_A, server_id: SID_A, peer: "pa-1", peer_seen_at: "2020-01-01T00:00:00.000Z",
    serverName: "bantou-server", serverHost: "lenovo", state: "done", createdAt: "2026-11-03T00:00:00.000Z", pending: [],
  }]));
  const { mgr, setFail } = setup([newA("pa-1")], { peerTtlMs: 1000 });
  setFail(true);
  await mgr.restore();
  await tick();
  assert.equal((await readRecords())[0].peer, "pa-1", "発見失敗では消さない");
  assert.equal(mgr.list().length, 1);
});

// -- review 第2回 --

test("review N1: server 再起動直後（旧 peer id が発見に残り、hello に答えない）でも、新 peer が選ばれる。peer id 指定は旧 peer でも通る", async () => {
  const c = new FakeClient();
  c.peers = [lp("old-1", "lenovo")];
  c.helloReplies.set("old-1", hello(idOf("srv-ffffffffff", "lenovo", "alice", "/w")));
  const link = linkWith(c);
  await link.identifiedPeers!(); // 旧 peer の識別を学習済み
  // server 再起動: 新 peer id が同じ server_id で現れ、旧 peer は死んだが発見に残る
  c.peers = [lp("old-1", "lenovo"), lp("new-2", "lenovo")];
  c.helloReplies.delete("old-1");
  c.helloReplies.set("new-2", hello(idOf("srv-ffffffffff", "lenovo", "alice", "/w")));
  assert.equal((await link.selectPeer()).id, "new-2", "指定なし");
  assert.equal((await link.selectPeer("srv-ffffffffff")).id, "new-2", "server_id");
  assert.equal((await link.selectPeer("lenovo")).id, "new-2", "host 名");
  assert.deepEqual((await link.identifiedPeers!()).map((p) => p.id), ["new-2"], "findPeer が使う一覧からも旧 peer は除かれる");
  assert.equal((await link.selectPeer("old-1")).id, "old-1", "peer id 指定は常に通る");
  assert.equal((await link.selectPeer("new-2")).id, "new-2");
  await link.close();
});

test("review N1: 両方が hello に答える時は従来どおり重複エラー。再確認は DUP_RECHECK_MS に 1 回まで（連打しない）。間隔を過ぎれば再確認する", async () => {
  const c = new FakeClient();
  c.peers = [lp("c-1", "lenovo"), lp("c-2", "lenovo")];
  c.helloReplies.set("c-1", hello(idOf("srv-eeeeeeeeee", "lenovo", "alice", "/home/alice/ws")));
  c.helloReplies.set("c-2", hello(idOf("srv-eeeeeeeeee", "lenovo", "alice", "/mnt/copy/ws")));
  let t = 5_000_000;
  const link = linkWith(c, () => t);
  const helloCount = () => c.sent.filter((s) => s.msg.type === "hello").length;
  await assert.rejects(link.selectPeer(), /同じ server_id srv-eeeeeeeeee/); // 識別 2 + 生存確認 2
  assert.equal(helloCount(), 4);
  await assert.rejects(link.selectPeer("srv-eeeeeeeeee"), /同じ server_id/);
  await link.identifiedPeers!();
  await Promise.all([link.selectPeer("c-1"), link.identifiedPeers!(), link.identifiedPeers!()]);
  assert.equal(helloCount(), 4, "間隔内は再確認しない");
  t += DUP_RECHECK_MS;
  await assert.rejects(Promise.all([link.selectPeer(), link.selectPeer()]), /同じ server_id/);
  assert.equal(helloCount(), 6, "間隔を過ぎたら 1 回だけ（同時実行は 1 つにまとめる）再確認する");
  await link.close();
});

test("review N2: 同じ peer を持つ 2 記録を restore で読み込んでも（syncRecord を通さない）、遅延返信は識別が一致する新しい記録に届く", async () => {
  const SID_D = "srv-dddddddddd";
  const base = { remote_id: CAP, session: "pm1", serverName: "bantou-server", serverHost: "lenovo", state: "done", createdAt: "2026-11-03T00:00:00.000Z", pending: [], peer: "p-1" };
  await writeFile(join(dir, "remotes.json"), JSON.stringify([{ ...base, server: SID_A, server_id: SID_A }, { ...base, server: SID_D, server_id: SID_D }]));
  const { mgr, setFail } = setup([peerOf("p-1", { server_id: SID_D, host: "lenovo", user: "alice", workspace: "/w2" })]);
  setFail(true); // 発見に失敗 = restore が記録を同期しない
  await mgr.restore();
  await tick();
  const ok = mgr.applyLateReply({ bantou: 1, type: "error", ok: false, message: "late-n2", task_id: "t-old", cap_id: CAP } as never, "p-1");
  assert.equal(ok, true);
  const recs = mgr.list();
  assert.match(String(recs.find((x) => x.server_id === SID_D)?.error ?? ""), /late-n2/);
  assert.doesNotMatch(String(recs.find((x) => x.server_id === SID_A)?.error ?? ""), /late-n2/);
});

// -- review 第3回 --

test("review N1 補足: 全員が一時的に hello に答えなかった結果は保持しない。復帰後は間隔を待たず、答えた peer だけが選ばれる", async () => {
  const c = new FakeClient();
  c.peers = [lp("old-1", "lenovo"), lp("new-2", "lenovo")];
  for (const id of ["old-1", "new-2"]) c.helloReplies.set(id, hello(idOf("srv-ffffffffff", "lenovo", "alice", "/w")));
  let t = 7_000_000;
  const link = linkWith(c, () => t);
  await assert.rejects(link.selectPeer(), /同じ server_id/); // 識別を取り、両方が答える = 重複
  t += DUP_RECHECK_MS; // 前の確認結果は古い
  const orig = c.helloReplies;
  c.helloReplies = new Map(); // 全員が一時的に無応答
  await assert.rejects(link.selectPeer(), /同じ server_id/); // 誰も答えない = 落とさない
  c.helloReplies = new Map([["new-2", orig.get("new-2")!]]); // new-2 が復帰（時刻は進めない）
  assert.equal((await link.selectPeer()).id, "new-2", "無応答の結果が残らず、同じ時刻でも再確認される");
  await link.close();
});
