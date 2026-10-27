import assert from "node:assert/strict";
import { test } from "node:test";
import { parseConfig } from "../src/config.js";
import { createPinnedClient, createServerLink, type LinkClient } from "../src/server-link.js";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

class FakeClient implements LinkClient {
  sent: Record<string, unknown>[] = [];
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
  async send(to: string, text: string): Promise<unknown> {
    assert.equal(to, "bantou-server");
    if (this.failSend) throw new Error("send failed");
    this.sent.push(JSON.parse(text) as Record<string, unknown>);
    return {};
  }
  onMessage(h: Parameters<LinkClient["onMessage"]>[0]): () => void {
    this.handler = h;
    return () => {
      this.handler = () => {};
    };
  }
  reply(obj: object, from = "bantou-server"): void {
    void this.handler({ from_name: from, text: JSON.stringify(obj) });
  }
}

function setup(timeoutMs = 2000, peerWatchMs?: number) {
  const cfg = parseConfig({ servers: [{ name: "s1", broker: "http://127.0.0.1:1", timeoutMs }] }, "/x/c.json");
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
  const cfg = parseConfig({ servers: [{ name: "s1", broker: "http://127.0.0.1:1", timeoutMs: 500 }] }, "/x/c.json");
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
  assert.deepEqual(l, [{ name: "s1", broker: "http://127.0.0.1:1", connected: false, reachable: false, peerId: null }]);

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
  const cfg = parseConfig({ servers: [{ name: "s1", broker: "http://127.0.0.1:1" }] }, "/x/c.json");
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

test("実 client は設定の broker だけに接続し、7901 へフォールバックしない", async () => {
  const cfg = parseConfig({ servers: [{ name: "s1", broker: "http://127.0.0.1:1/" }] }, "/x/c.json");
  const logs: string[] = [];
  const client = createPinnedClient(cfg.servers[0], (m) => logs.push(m));
  await assert.rejects(client.connect(), (e: Error) => {
    assert.match(e.message, /http:\/\/127\.0\.0\.1:1 is not reachable/);
    assert.doesNotMatch(e.message, /7901/);
    return true;
  });
  assert.ok(!logs.some((l) => l.includes("7901")), logs.join("\n"));
  await client.close();
});
