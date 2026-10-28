import assert from "node:assert/strict";
import { test } from "node:test";
import { MESSENGER_PROTOCOL } from "@agent-hand/bantou-protocol";
import { parseConfig } from "../src/config.js";
import {
  createClient,
  createServerLink,
  stripWarning,
  type LinkClient,
  type LinkInbound,
  type LinkMeta,
  type LinkPeer,
} from "../src/server-link.js";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

class FakeClient implements LinkClient {
  sent: Record<string, unknown>[] = [];
  sentTo: string[] = [];
  sentMeta: Array<LinkMeta | undefined> = [];
  /** listPeers の返す peer。undefined なら 0.9 broker 相当（BROKER_UNSUPPORTED）。 */
  peers: LinkPeer[] | undefined = undefined;
  listCalls: Array<{ scope?: string; filter?: { protocol?: string; version?: string } }> = [];
  handler: Parameters<LinkClient["onMessage"]>[0] = () => {};
  connectCalls = 0;
  failConnect = false;
  failSend = false;
  closed = false;
  peer = { id: "peer-1" };
  async connect(): Promise<void> {
    this.connectCalls++;
    if (this.failConnect) throw new Error("conn refused");
  }
  async close(): Promise<void> {
    this.closed = true;
  }
  async send(to: string, text: string, _delivery?: "pull" | "push", meta?: LinkMeta): Promise<unknown> {
    if (this.failSend) throw new Error("send failed");
    this.sentTo.push(to);
    this.sentMeta.push(meta);
    this.sent.push(JSON.parse(text) as Record<string, unknown>);
    return {};
  }
  async listPeers(scope?: "all" | "host" | "directory" | "repo", filter?: { protocol?: string; version?: string }): Promise<LinkPeer[]> {
    this.listCalls.push({ scope, filter });
    if (!this.peers) throw new Error("BROKER_UNSUPPORTED");
    return this.peers;
  }
  onMessage(h: Parameters<LinkClient["onMessage"]>[0]): () => void {
    this.handler = h;
    return () => {
      this.handler = () => {};
    };
  }
  reply(obj: object, from = "bantou-server", extra: Partial<LinkInbound> = {}): void {
    void this.handler({ from_name: from, text: JSON.stringify(obj), ...extra });
  }
  replyText(text: string, extra: Partial<LinkInbound> = {}): void {
    void this.handler({ from_name: "bantou-server", text, ...extra });
  }
}

function setup(timeoutMs = 2000, peerWatchMs?: number) {
  const cfg = parseConfig({ servers: [{ name: "s1", timeoutMs }] }, "/x/c.json");
  const clients: FakeClient[] = [];
  const logs: string[] = [];
  const link = createServerLink({
    config: cfg,
    log: (m) => logs.push(m),
    clientFactory: () => {
      const c = new FakeClient();
      clients.push(c);
      return c;
    },
    healthCheck: async () => true,
    peerWatchMs,
  });
  return { link, clients, logs };
}

const capResult = (id: string, text = "ok") => ({
  bantou: 1, type: "cap_result", cap_id: id, session_id: "sid", ok: true, result_text: text,
});
const workerResult = (id: string) => ({
  bantou: 1, type: "worker_result", worker_id: id, session_id: "sid", ok: true, result_text: "w",
});
const statusResult = (n: number) => ({
  bantou: 1, type: "status_result", ok: true,
  caps: [{ kind: "cap", id: `c${n}`, path: "/p", session_id: null, state: "idle", last_started_at: null, last_finished_at: null, retries: 0, queued: 0 }],
  workers: [],
});

test("kickCap: 一致する cap_result で解決し、指示に bantou/type が付く", async () => {
  const { link, clients } = setup();
  const p = link.kickCap("s1", { cap_id: "c1", prompt: "hi", reason: "t" });
  await sleep(20);
  assert.deepEqual(clients[0].sent, [{ bantou: 1, type: "kick_cap", cap_id: "c1", prompt: "hi", reason: "t" }]);
  clients[0].reply(capResult("c1", "done"));
  const r = await p;
  assert.equal(r.type, "cap_result");
  assert.equal((r as { result_text: string }).result_text, "done");
  await link.close();
});

test("別 cap_id の kick は順不同で独立に解決", async () => {
  const { link, clients } = setup();
  const a = link.kickCap("s1", { cap_id: "a", prompt: "x" });
  const b = link.kickCap("s1", { cap_id: "b", prompt: "y" });
  await sleep(30);
  assert.equal(clients[0].sent.length, 2);
  clients[0].reply(capResult("b", "B"));
  clients[0].reply(capResult("a", "A"));
  const [ra, rb] = await Promise.all([a, b]);
  assert.equal((ra as { result_text: string }).result_text, "A");
  assert.equal((rb as { result_text: string }).result_text, "B");
  await link.close();
});

test("同じ cap_id の kick は直列（前の返信後に次を送る）", async () => {
  const { link, clients } = setup();
  const a1 = link.kickCap("s1", { cap_id: "a", prompt: "1" });
  const a2 = link.kickCap("s1", { cap_id: "a", prompt: "2" });
  await sleep(30);
  assert.equal(clients[0].sent.length, 1);
  clients[0].reply(capResult("a", "r1"));
  assert.equal((await a1 as { result_text: string }).result_text, "r1");
  await sleep(30);
  assert.equal(clients[0].sent.length, 2);
  assert.equal(clients[0].sent[1].prompt, "2");
  clients[0].reply(capResult("a", "r2"));
  assert.equal((await a2 as { result_text: string }).result_text, "r2");
  await link.close();
});

test("worker_result は worker_id で照合", async () => {
  const { link, clients } = setup();
  const p = link.resumeWorker("s1", { worker_id: "w1", prompt: "go" });
  await sleep(20);
  assert.equal(clients[0].sent[0].type, "resume_worker");
  clients[0].reply(workerResult("w1"));
  assert.equal((await p).type, "worker_result");
  await link.close();
});

test("対応しない返信は無視される", async () => {
  const { link, clients, logs } = setup(150);
  const p = link.kickCap("s1", { cap_id: "a", prompt: "x" });
  await sleep(20);
  clients[0].reply(capResult("zzz"));
  clients[0].reply(capResult("a"), "someone-else");
  clients[0].handler({ from_name: "bantou-server", text: "not json" });
  const r = await p;
  assert.equal(r.type, "error");
  assert.match((r as { message: string }).message, /タイムアウト \(150ms\)/);
  assert.ok(logs.some((l) => l.includes("対応する待ちなし")));
  await link.close();
});

test("タイムアウトは error 返信（command 付き）", async () => {
  const { link } = setup(60);
  const r = await link.kickCap("s1", { cap_id: "a", prompt: "x" });
  assert.deepEqual(r, { bantou: 1, type: "error", ok: false, message: "タイムアウト (60ms)", command: "kick_cap" });
  await link.close();
});

test("status は FIFO で解決", async () => {
  const { link, clients } = setup();
  const s1 = link.status("s1");
  const s2 = link.status("s1");
  await sleep(30);
  assert.equal(clients[0].sent.length, 2);
  clients[0].reply(statusResult(1));
  clients[0].reply(statusResult(2));
  const [r1, r2] = await Promise.all([s1, s2]);
  assert.equal((r1 as { caps: { id: string }[] }).caps[0].id, "c1");
  assert.equal((r2 as { caps: { id: string }[] }).caps[0].id, "c2");
  await link.close();
});

test("error 返信は command の種類で照合、command 無しは最古", async () => {
  const { link, clients } = setup();
  const k = link.kickCap("s1", { cap_id: "a", prompt: "x" });
  const s = link.status("s1");
  await sleep(30);
  clients[0].reply({ bantou: 1, type: "error", ok: false, message: "status ng", command: "status" });
  const rs = await s;
  assert.equal((rs as { message: string }).message, "status ng");
  clients[0].reply({ bantou: 1, type: "error", ok: false, message: "oldest" });
  const rk = await k;
  assert.equal((rk as { message: string }).message, "oldest");
  await link.close();
});

test("未定義 server は例外", async () => {
  const { link } = setup();
  await assert.rejects(link.status("nope"), /未定義の server/);
  await assert.rejects(link.kickCap("nope", { cap_id: "a", prompt: "x" }), /未定義の server/);
});

test("接続失敗はクラッシュせず、次回使用時に再接続", async () => {
  const cfg = parseConfig({ servers: [{ name: "s1", timeoutMs: 500 }] }, "/x/c.json");
  const clients: FakeClient[] = [];
  const link = createServerLink({
    config: cfg,
    log: () => {},
    healthCheck: async () => false,
    clientFactory: () => {
      const c = new FakeClient();
      c.failConnect = clients.length === 0;
      clients.push(c);
      return c;
    },
  });
  await link.connectAll();
  let l = await link.list();
  assert.deepEqual(l, [{ name: "s1", connected: false, reachable: false, peerId: null, serverPeer: null }]);

  const p = link.status("s1");
  await sleep(30);
  assert.equal(clients.length, 2);
  clients[1].reply(statusResult(1));
  assert.equal((await p).type, "status_result");
  l = await link.list();
  assert.equal(l[0].connected, true);
  assert.equal(l[0].peerId, "peer-1");
  await link.close();
});

test("接続できない時は error 返信", async () => {
  const cfg = parseConfig({ servers: [{ name: "s1" }] }, "/x/c.json");
  const link = createServerLink({
    config: cfg,
    log: () => {},
    clientFactory: () => {
      const c = new FakeClient();
      c.failConnect = true;
      return c;
    },
  });
  const r = await link.status("s1");
  assert.equal(r.type, "error");
  assert.match((r as { message: string }).message, /接続できない/);
});

test("送信失敗は error 返信で、次回は client を作り直す", async () => {
  const { link, clients } = setup();
  const p = link.status("s1");
  await sleep(20);
  clients[0].reply(statusResult(1));
  await p;
  clients[0].failSend = true;
  const r = await link.status("s1");
  assert.equal(r.type, "error");
  assert.match((r as { message: string }).message, /送信失敗/);
  const p2 = link.status("s1");
  await sleep(30);
  assert.equal(clients.length, 2);
  clients[1].reply(statusResult(2));
  assert.equal((await p2).type, "status_result");
  await link.close();
});

test("close は待ちを error で解決する", async () => {
  const { link } = setup();
  const p = link.kickCap("s1", { cap_id: "a", prompt: "x" });
  await sleep(20);
  await link.close();
  const r = await p;
  assert.equal(r.type, "error");
  assert.match((r as { message: string }).message, /center 終了/);
});

test("error 返信に cap_id / worker_id があれば id で照合する", async () => {
  const { link, clients } = setup();
  const a = link.kickCap("s1", { cap_id: "a", prompt: "x" });
  const b = link.kickCap("s1", { cap_id: "b", prompt: "x" });
  const w = link.resumeWorker("s1", { worker_id: "w", prompt: "x" });
  await sleep(30);
  clients[0].reply({ bantou: 1, type: "error", ok: false, message: "b ng", command: "kick_cap", cap_id: "b" });
  assert.equal((await b as { message: string }).message, "b ng");
  clients[0].reply({ bantou: 1, type: "error", ok: false, message: "w ng", command: "resume_worker", worker_id: "w" });
  assert.equal((await w as { message: string }).message, "w ng");
  clients[0].reply(capResult("a"));
  assert.equal((await a).type, "cap_result");
  await link.close();
});

test("接続を作り直すと、旧 client 宛ての待ちは即エラー", async () => {
  const { link, clients } = setup();
  const p = link.kickCap("s1", { cap_id: "a", prompt: "x" });
  await sleep(20);
  // 別の指示の送信失敗で接続を作り直させる
  clients[0].failSend = true;
  const f = await link.status("s1");
  assert.match((f as { message: string }).message, /送信失敗/);
  const p2 = link.status("s1");
  const r = await p;
  assert.equal(r.type, "error");
  assert.match((r as { message: string }).message, /接続を作り直したため中断/);
  await sleep(20);
  clients[1].reply(statusResult(1));
  assert.equal((await p2).type, "status_result");
  await link.close();
});

test("peer id が変わると待ちを即エラーにして作り直す", async () => {
  const { link, clients, logs } = setup(2000, 20);
  const p = link.kickCap("s1", { cap_id: "a", prompt: "x" });
  await sleep(10);
  clients[0].peer = { id: "peer-2" };
  const r = await p;
  assert.match((r as { message: string }).message, /peer id が変わった/);
  assert.ok(logs.some((l) => l.includes("peer id 変化")));
  await link.close();
});

test("close 後の指示は接続せず即エラー", async () => {
  const { link, clients } = setup();
  await link.close();
  const r = await link.kickCap("s1", { cap_id: "a", prompt: "x" });
  assert.equal(r.type, "error");
  assert.match((r as { message: string }).message, /center 終了/);
  await link.connectAll();
  assert.equal(clients.length, 0);
});

test("接続中に close されたら client を捨てて指示はエラー", async () => {
  const { link, clients } = setup();
  const p = link.kickCap("s1", { cap_id: "a", prompt: "x" });
  const closing = link.close();
  const r = await p;
  await closing;
  assert.equal(r.type, "error");
  assert.match((r as { message: string }).message, /center 終了/);
  assert.ok(clients.every((c) => c.closed));
});

test("実 client は通常の解決に従う（env の HOST/PORT が効く。URL を固定しない）", async () => {
  const cfg = parseConfig({ servers: [{ name: "s1" }] }, "/x/c.json");
  const keys = ["AGENT_MESSENGER_HOST", "AGENT_MESSENGER_PORT"] as const;
  const saved = keys.map((k) => process.env[k]);
  // テスト専用の env 上書き（通常解決の 1 段目）。到達不能な 127.0.0.1:1 を指して失敗メッセージで解決先を確かめる
  process.env.AGENT_MESSENGER_HOST = "127.0.0.1";
  process.env.AGENT_MESSENGER_PORT = "1";
  const logs: string[] = [];
  const client = createClient(cfg.servers[0], (m) => logs.push(m));
  try {
    await assert.rejects(client.connect(), /http:\/\/127\.0\.0\.1:1 is not reachable/);
  } finally {
    keys.forEach((k, i) => {
      if (saved[i] === undefined) delete process.env[k];
      else process.env[k] = saved[i];
    });
    await client.close();
  }
});

const peerOf = (id: string, name: string, version = "1.0.0"): LinkPeer => ({
  id, name, protocols: [{ name: "bantou", version }],
});

function setupDiscovery(server: object = {}, peers?: LinkPeer[]) {
  const cfg = parseConfig({ servers: [{ name: "s1", timeoutMs: 2000, ...server }] }, "/x/c.json");
  const clients: FakeClient[] = [];
  const logs: string[] = [];
  const link = createServerLink({
    config: cfg,
    log: (m) => logs.push(m),
    clientFactory: () => {
      const c = new FakeClient();
      c.peers = peers;
      clients.push(c);
      return c;
    },
    healthCheck: async () => true,
  });
  return { link, clients, logs };
}

test("meta: 名前宛て（発見できない時）でも meta {protocol: bantou, version} を付ける", async () => {
  const { link, clients } = setup();
  const p = link.status("s1");
  await sleep(20);
  assert.deepEqual(clients[0].sentTo, ["bantou-server"]);
  assert.deepEqual(clients[0].sentMeta, [{ protocol: "bantou", version: MESSENGER_PROTOCOL.version }]);
  clients[0].reply(statusResult(1));
  await p;
  await link.close();
});

test("発見: listPeers(all, {protocol: bantou}) の peer id へ送り、meta の version は peer の宣言を使う", async () => {
  const { link, clients } = setupDiscovery({}, [peerOf("srv-id-1", "my-host", "1.2.0")]);
  const p = link.kickCap("s1", { cap_id: "c1", prompt: "go" });
  await sleep(20);
  assert.deepEqual(clients[0].listCalls, [{ scope: "all", filter: { protocol: "bantou" } }]);
  assert.deepEqual(clients[0].sentTo, ["srv-id-1"]);
  assert.deepEqual(clients[0].sentMeta, [{ protocol: "bantou", version: "1.2.0" }]);
  // 発見した id からの返信（meta 無し）も受ける
  clients[0].reply(capResult("c1", "found"), "my-host", { from_id: "srv-id-1" });
  const r = await p;
  assert.equal((r as { result_text: string }).result_text, "found");
  const l = await link.list();
  assert.equal(l[0].serverPeer, "srv-id-1");
  await link.close();
});

test("発見: 複数なら name が bantou-server を優先、無ければ先頭", async () => {
  const a = setupDiscovery({}, [peerOf("id-a", "other"), peerOf("id-b", "bantou-server"), peerOf("id-c", "zzz")]);
  const p = a.link.status("s1");
  await sleep(20);
  assert.deepEqual(a.clients[0].sentTo, ["id-b"]);
  a.clients[0].reply(statusResult(1));
  await p;
  await a.link.close();

  const b = setupDiscovery({}, [peerOf("id-x", "first"), peerOf("id-y", "second")]);
  const q = b.link.status("s1");
  await sleep(20);
  assert.deepEqual(b.clients[0].sentTo, ["id-x"]);
  b.clients[0].reply(statusResult(1));
  await q;
  await b.link.close();
});

test("発見: 0 件・BROKER_UNSUPPORTED は bantou-server 宛てへフォールバック", async () => {
  const zero = setupDiscovery({}, []);
  const p = zero.link.status("s1");
  await sleep(20);
  assert.deepEqual(zero.clients[0].sentTo, ["bantou-server"]);
  assert.ok(zero.logs.some((m) => m.includes("0 件")));
  zero.clients[0].reply(statusResult(1));
  await p;
  await zero.link.close();

  const old = setupDiscovery({}, undefined);
  const q = old.link.status("s1");
  await sleep(20);
  assert.deepEqual(old.clients[0].sentTo, ["bantou-server"]);
  assert.ok(old.logs.some((m) => m.includes("BROKER_UNSUPPORTED")));
  old.clients[0].reply(statusResult(1));
  await q;
  await old.link.close();
});

test("servers[].peer 指定があれば発見せずその名前へ送る（従来の名前指定）", async () => {
  const { link, clients } = setupDiscovery({ peer: "my-named-server" }, [peerOf("srv-id-1", "bantou-server")]);
  const p = link.status("s1");
  await sleep(20);
  assert.deepEqual(clients[0].listCalls, []);
  assert.deepEqual(clients[0].sentTo, ["my-named-server"]);
  assert.deepEqual(clients[0].sentMeta, [{ protocol: "bantou", version: MESSENGER_PROTOCOL.version }]);
  clients[0].reply(statusResult(1), "my-named-server");
  assert.equal((await p).type, "status_result");
  await link.close();
});

test("peer id は再登録で変わるので、リクエストごとに解決し直す", async () => {
  const { link, clients } = setupDiscovery({}, [peerOf("id-1", "bantou-server")]);
  const p1 = link.status("s1");
  await sleep(20);
  clients[0].reply(statusResult(1));
  await p1;
  clients[0].peers = [peerOf("id-2", "bantou-server")];
  const p2 = link.status("s1");
  await sleep(20);
  assert.deepEqual(clients[0].sentTo, ["id-1", "id-2"]);
  clients[0].reply(statusResult(2));
  await p2;
  await link.close();
});

test("受信: meta が bantou なら名前が違っても受け、他 protocol・他名前は無視", async () => {
  const { link, clients, logs } = setup();
  const p = link.kickCap("s1", { cap_id: "c1", prompt: "go" });
  await sleep(20);
  clients[0].reply(capResult("c1", "x"), "stranger");
  clients[0].reply(capResult("c1", "x"), "stranger", { meta: { protocol: "other", version: "1" } });
  await sleep(20);
  assert.ok(logs.some((m) => m.startsWith("無視:")));
  clients[0].reply(capResult("c1", "by-meta"), "renamed", { meta: { protocol: "bantou", version: "1.0.0" } });
  assert.equal(((await p) as { result_text: string }).result_text, "by-meta");
  await link.close();
});

test("version 不一致の警告行が先頭に付いても本文を解釈する", async () => {
  assert.equal(stripWarning("[agent-messenger warning] protocol version mismatch: a\n{\"x\":1}"), '{"x":1}');
  assert.equal(stripWarning("[agent-messenger warning] a\n[agent-messenger warning] b\n{}"), "{}");
  assert.equal(stripWarning("{}"), "{}");
  const { link, clients } = setup();
  const p = link.status("s1");
  await sleep(20);
  clients[0].replyText(`[agent-messenger warning] protocol version mismatch: x\n${JSON.stringify(statusResult(1))}`);
  assert.equal((await p).type, "status_result");
  await link.close();
});

test("reachable の既定は接続を確保できるか（listPeers 非対応の 0.9 broker でも true）", async () => {
  const cfg = parseConfig({ servers: [{ name: "s1" }] }, "/x/c.json");
  let fail = false;
  const link = createServerLink({
    config: cfg,
    log: () => {},
    clientFactory: () => {
      const c = new FakeClient();
      c.failConnect = fail;
      return c;
    },
  });
  assert.equal((await link.list())[0].reachable, true);
  await link.close();
  fail = true;
  const link2 = createServerLink({ config: cfg, log: () => {}, clientFactory: () => Object.assign(new FakeClient(), { failConnect: true }) });
  assert.equal((await link2.list())[0].reachable, false);
  await link2.close();
});

// -- 発見ベース（config.servers に依存しない）: peers / selectPeer / kickCapOn / stopCapOn --

function setupNoServers(peers?: LinkPeer[]) {
  const cfg = parseConfig({}, "/x/c.json");
  const clients: FakeClient[] = [];
  const link = createServerLink({
    config: cfg,
    log: () => {},
    clientFactory: () => {
      const c = new FakeClient();
      c.peers = peers;
      clients.push(c);
      return c;
    },
  });
  return { link, clients };
}

test("発見ベース: servers が空でも peers / selectPeer が protocol 絞り込みで動く。list / connectAll には出ない", async () => {
  const { link, clients } = setupNoServers([peerOf("id-a", "bantou-server", "1.1.0"), peerOf("id-b", "other")]);
  assert.deepEqual(await link.list(), []);
  await link.connectAll();
  assert.equal(clients.length, 0);
  assert.deepEqual(await link.peers(), [
    { id: "id-a", name: "bantou-server", version: "1.1.0" },
    { id: "id-b", name: "other", version: "1.0.0" },
  ]);
  assert.deepEqual(clients[0].listCalls, [{ scope: "all", filter: { protocol: "bantou" } }]);
  assert.equal((await link.selectPeer()).id, "id-a");
  assert.equal((await link.selectPeer("id-b")).name, "other");
  assert.equal((await link.selectPeer("other")).id, "id-b");
  await assert.rejects(link.selectPeer("zzz"), /見つからない.*bantou-server\(id-a\)/);
  assert.equal(clients.length, 1);
  await link.close();
});

test("発見ベース: 0 件・発見不能（0.9 broker）・接続失敗は selectPeer が説明付きで投げる", async () => {
  const empty = setupNoServers([]);
  await assert.rejects(empty.link.selectPeer(), /見つからない/);
  await empty.link.close();
  const old = setupNoServers(undefined);
  await assert.rejects(old.link.selectPeer(), /BROKER_UNSUPPORTED/);
  await old.link.close();
  const cfg = parseConfig({}, "/x/c.json");
  const down = createServerLink({ config: cfg, log: () => {}, clientFactory: () => Object.assign(new FakeClient(), { failConnect: true }) });
  await assert.rejects(down.selectPeer(), /messenger に接続できない/);
  await down.close();
});

test("発見ベース: kickCapOn は選んだ peer id 宛てに declared version の meta 付きで送り、cap_result を返す", async () => {
  const peer = { id: "id-a", name: "bantou-server", version: "1.1.0" };
  const { link, clients } = setupNoServers([peerOf("id-a", "bantou-server", "1.1.0")]);
  const p = link.kickCapOn(peer, { cap_id: "r-1", prompt: "go" });
  await sleep(20);
  assert.deepEqual(clients[0].sentTo, ["id-a"]);
  assert.deepEqual(clients[0].sentMeta, [{ protocol: "bantou", version: "1.1.0" }]);
  assert.deepEqual(clients[0].sent[0], { bantou: 1, type: "kick_cap", cap_id: "r-1", prompt: "go" });
  clients[0].reply(capResult("r-1", "ok"), "bantou-server", { from_id: "id-a" });
  assert.equal(((await p) as { result_text: string }).result_text, "ok");
  await link.close();
});

test("stop_cap: stop_result は stop の待ちだけを解決し、同じ cap_id の kick_cap の待ちは続く", async () => {
  const peer = { id: "id-a", name: "bantou-server" };
  const { link, clients } = setupNoServers([peerOf("id-a", "bantou-server")]);
  const kick = link.kickCapOn(peer, { cap_id: "r-1", prompt: "go" });
  await sleep(20);
  const stop = link.stopCapOn(peer, { cap_id: "r-1" }); // kick の実行中でも直列待ちにならない
  await sleep(20);
  assert.deepEqual(clients[0].sent.map((m) => m.type), ["kick_cap", "stop_cap"]);
  clients[0].reply({ bantou: 1, type: "stop_result", ok: true, cap_id: "r-1", stopped: true });
  assert.deepEqual(await stop, { bantou: 1, type: "stop_result", ok: true, cap_id: "r-1", stopped: true });
  let kickDone = false;
  void kick.then(() => (kickDone = true));
  await sleep(20);
  assert.equal(kickDone, false);
  clients[0].reply({ ...capResult("r-1", ""), ok: false, error: "stop_cap により停止" });
  assert.equal(((await kick) as { ok: boolean }).ok, false);
  await link.close();
});

test("stop_cap の error（command=stop_cap, cap_id 付き）は kick_cap の待ちと取り違えず stop の待ちへ", async () => {
  const peer = { id: "id-a", name: "bantou-server" };
  const { link, clients } = setupNoServers([peerOf("id-a", "bantou-server")]);
  const kick = link.kickCapOn(peer, { cap_id: "r-1", prompt: "go" });
  await sleep(20);
  const stop = link.stopCapOn(peer, { cap_id: "r-1" });
  await sleep(20);
  clients[0].reply({ bantou: 1, type: "error", ok: false, message: "ng", command: "stop_cap", cap_id: "r-1" });
  assert.equal((await stop).type, "error");
  let kickDone = false;
  void kick.then(() => (kickDone = true));
  await sleep(20);
  assert.equal(kickDone, false);
  await link.close();
  assert.equal((await kick).type, "error"); // close で中断
});

test("config.servers があれば発見ベースは先頭 server の client を共有する（接続は 1 本）", async () => {
  const cfg = parseConfig({ servers: [{ name: "s1" }] }, "/x/c.json");
  const clients: FakeClient[] = [];
  const link = createServerLink({
    config: cfg, log: () => {},
    clientFactory: () => { const c = new FakeClient(); c.peers = [peerOf("id-a", "bantou-server")]; clients.push(c); return c; },
  });
  await link.connectAll();
  assert.equal((await link.selectPeer()).id, "id-a");
  assert.equal(clients.length, 1);
  assert.deepEqual((await link.list()).map((s) => s.name), ["s1"]);
  await link.close();
});
