import assert from "node:assert/strict";
import { test } from "node:test";
import { MESSENGER_PROTOCOL, isLaunchMessage, isServerMessage } from "@agent-hand/bantou-protocol";
import { createServerLink, stripWarning, type LinkClient, type LinkInbound, type LinkMeta, type LinkPeer } from "../src/server-link.js";

class FakeClient implements LinkClient {
  sent: Array<{ to: string; text: string; delivery?: string; meta?: LinkMeta }> = [];
  peers: LinkPeer[] | undefined = [];
  listCalls: Array<{ scope?: string; filter?: unknown }> = [];
  handler: Parameters<LinkClient["onMessage"]>[0] = () => {};
  failConnect = false;
  failSend = false;
  closed = false;
  name = "";
  peer = { id: "center-1" };
  async connect(): Promise<void> {
    if (this.failConnect) throw new Error("name already taken");
  }
  async close(): Promise<void> {
    this.closed = true;
  }
  async send(to: string, text: string, delivery?: "pull" | "push", meta?: LinkMeta): Promise<unknown> {
    if (this.failSend) throw new Error("send failed");
    this.sent.push({ to, text, ...(delivery ? { delivery } : {}), ...(meta ? { meta } : {}) });
    return {};
  }
  async listPeers(scope?: "all" | "host" | "directory" | "repo", filter?: unknown): Promise<LinkPeer[]> {
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
  inbound(m: Partial<LinkInbound> & { text: string }): void {
    void this.handler({ from_name: "bantou-server-aaaaaaaaaa", ...m });
  }
}

/** peers = null: broker が peer の列挙に対応していない（listPeers が投げる）。 */
function setup(peers: LinkPeer[] | null = []) {
  const client = new FakeClient();
  client.peers = peers ?? undefined;
  const names: string[] = [];
  const logs: string[] = [];
  const link = createServerLink({
    name: "bantou-center-0123456789",
    log: (m) => logs.push(m),
    clientFactory: (n) => {
      names.push(n);
      client.name = n;
      return client;
    },
  });
  return { link, client, names, logs };
}

const META = { protocol: MESSENGER_PROTOCOL.protocol, version: MESSENGER_PROTOCOL.version };

test("connect: center の名前で client を作る。登録に失敗（同名など）したら投げ、client を閉じる", async () => {
  const a = setup();
  await a.link.connect();
  assert.deepEqual(a.names, ["bantou-center-0123456789"]);
  assert.equal(a.link.name, "bantou-center-0123456789");
  await a.link.close();

  const b = setup();
  b.client.failConnect = true;
  await assert.rejects(() => b.link.connect(), /name already taken/);
  assert.equal(b.client.closed, true);
  // 接続できていないので送れない
  await assert.rejects(() => b.link.stop("srv", "pm1-cap"), /接続していない/);
});

test("launch: schema があれば本文に入る（guard を通る）。無ければ schema を入れない", async () => {
  const { link, client } = setup();
  await link.connect();
  const schema = { type: "http" as const, url: "http://h:7910/mcp/schemas", headers: { Authorization: "Bearer x" } };
  await link.launch("srv", { parentId: "pm1-cap", prompt: "p", ws: "ws://h/ws/worker", schema });
  await link.launch("srv", { parentId: "pm1-cap", prompt: "p", ws: "ws://h/ws/worker" });
  const a: unknown = JSON.parse(client.sent[0]!.text);
  const b = JSON.parse(client.sent[1]!.text) as Record<string, unknown>;
  assert.deepEqual((a as { schema: unknown }).schema, schema);
  assert.ok(isLaunchMessage(a));
  assert.equal("schema" in b, false);
  await link.close();
});

test("launch: 宛先は server の名前そのまま。本文は 1 つの JSON（invoke / launch）で、meta = bantou protocol", async () => {
  const { link, client } = setup();
  await link.connect();
  await link.launch("bantou-server-aaaaaaaaaa", { parentId: "pm1-cap", model: "sonnet", prompt: "do it", ws: "ws://h:7910/ws/worker?token=t" });
  assert.equal(client.sent.length, 1);
  const m = client.sent[0]!;
  assert.equal(m.to, "bantou-server-aaaaaaaaaa");
  assert.equal(m.delivery, "pull");
  assert.deepEqual(m.meta, META);
  const body: unknown = JSON.parse(m.text);
  assert.deepEqual(body, { protocol: "bantou", callType: "invoke", order: "launch", "parent-id": "pm1-cap", model: "sonnet", prompt: "do it", ws: "ws://h:7910/ws/worker?token=t" });
  assert.ok(isLaunchMessage(body));
  assert.ok(isServerMessage(body));
  await link.close();
});

test("stop / reply（answer・approve・reject）/ server-info: protocol の guard を通る本文で送る", async () => {
  const { link, client } = setup();
  await link.connect();
  await link.stop("srv", "pm1-cap");
  await link.reply("srv", { sessionId: "s-1", order: "answer", content: "yes" });
  await link.reply("srv", { sessionId: "s-2", order: "approve" });
  await link.reply("srv", { sessionId: "s-3", order: "reject", content: "ignored" });
  await link.requestServerInfo("srv");
  const bodies = client.sent.map((s) => JSON.parse(s.text) as unknown);
  assert.deepEqual(bodies, [
    { protocol: "bantou", callType: "invoke", order: "stop", "parent-id": "pm1-cap" },
    { protocol: "bantou", callType: "reply", order: "answer", "session-id": "s-1", content: "yes" },
    { protocol: "bantou", callType: "reply", order: "approve", "session-id": "s-2" },
    { protocol: "bantou", callType: "reply", order: "reject", "session-id": "s-3" },
    { protocol: "bantou", callType: "status", order: "server-info" },
  ]);
  for (const b of bodies) assert.ok(isServerMessage(b));
  for (const s of client.sent) assert.deepEqual(s.meta, META);
  await link.close();
});

test("送信失敗は投げる（呼び出し側が isError にする）", async () => {
  const { link, client } = setup();
  await link.connect();
  client.failSend = true;
  await assert.rejects(() => link.launch("srv", { parentId: "pm1-cap", model: "sonnet", prompt: "x", ws: "ws://h/ws/worker" }), /send failed/);
  await link.close();
});

test("server-info の答え: 送ってきた名前ごとに版を控える。他の message・不正な答えは控えない。警告行が付いても読める", async () => {
  const { link, client } = setup();
  await link.connect();
  assert.equal(link.serverVersionOf("bantou-server-aaaaaaaaaa"), undefined);
  client.inbound({ text: JSON.stringify({ protocol: "bantou", callType: "status", order: "server-info", version: "1.2.3" }) });
  assert.equal(link.serverVersionOf("bantou-server-aaaaaaaaaa"), "1.2.3");
  client.inbound({ from_name: "bantou-server-bbbbbbbbbb", text: `[agent-messenger warning] version mismatch\n${JSON.stringify({ protocol: "bantou", callType: "status", order: "server-info", version: "2.0.0" })}` });
  assert.equal(link.serverVersionOf("bantou-server-bbbbbbbbbb"), "2.0.0");
  client.inbound({ from_name: "x", text: "hello" });
  client.inbound({ from_name: "y", text: JSON.stringify({ protocol: "bantou", callType: "status", order: "server-info", version: "v1" }) });
  client.inbound({ from_name: "z", mode: "ping", text: JSON.stringify({ protocol: "bantou", callType: "status", order: "server-info", version: "9.9.9" }) });
  assert.equal(link.serverVersionOf("x"), undefined);
  assert.equal(link.serverVersionOf("y"), undefined);
  assert.equal(link.serverVersionOf("z"), undefined);
  await link.close();
});

test("stripWarning: 先頭の警告行だけ除く", () => {
  assert.equal(stripWarning("[agent-messenger warning] a\n[agent-messenger warning] b\n{}"), "{}");
  assert.equal(stripWarning("{}"), "{}");
});

test("notifyPeer: 名前が一致する peer（自分以外）へ push で送る。絞り込みは無し", async () => {
  const { link, client } = setup([{ id: "peer-1", name: "pm1-cap" }, { id: "center-1", name: "pm1-cap" }, { id: "sess-1", name: "pm1-cap" }]);
  await link.connect();
  const r = await link.notifyPeer("pm1-cap", "hello");
  assert.deepEqual(r, { ok: true, to: "peer-1" });
  assert.deepEqual(client.sent, [{ to: "peer-1", text: "hello", delivery: "push" }]);
  assert.deepEqual(client.listCalls, [{ scope: "all", filter: undefined }]);
  await link.close();
});

test("notifyPeer: 同名 peer が複数なら最後に登録したものへ送る", async () => {
  const { link, client, logs } = setup([
    { id: "new-1", name: "pm1-cap", registered_at: "2026-11-03T05:00:30.000Z" },
    { id: "old-1", name: "pm1-cap", registered_at: "2026-11-03T05:00:00.000Z" },
    { id: "none-1", name: "pm1-cap" },
  ]);
  await link.connect();
  assert.deepEqual(await link.notifyPeer("pm1-cap", "hello"), { ok: true, to: "new-1" });
  assert.deepEqual(client.sent, [{ to: "new-1", text: "hello", delivery: "push" }]);
  assert.ok(logs.some((l) => l.includes("通知先の peer が複数")));
  await link.close();
});

test("notifyPeer: peer がいない・列挙できない・送信失敗・未接続は ok:false で理由を返す（投げない）", async () => {
  const a = setup([]);
  await a.link.connect();
  const r1 = await a.link.notifyPeer("pm1-cap", "x");
  assert.equal(r1.ok, false);
  assert.match((r1 as { reason: string }).reason, /peer pm1-cap がいない/);

  const b = setup(null);
  await b.link.connect();
  const r2 = await b.link.notifyPeer("pm1-cap", "x");
  assert.equal(r2.ok, false);
  assert.match((r2 as { reason: string }).reason, /送信失敗|BROKER_UNSUPPORTED/);

  const c = setup([{ id: "sess-1", name: "pm1-cap" }]);
  await c.link.connect();
  c.client.failSend = true;
  const r3 = await c.link.notifyPeer("pm1-cap", "x");
  assert.equal(r3.ok, false);
  assert.match((r3 as { reason: string }).reason, /送信失敗: send failed/);

  const d = setup();
  const r4 = await d.link.notifyPeer("pm1-cap", "x");
  assert.equal(r4.ok, false);
  assert.match((r4 as { reason: string }).reason, /接続できない/);
});

test("notifyPeer: 印（mark）の exclude の id と、印の since より古い登録は宛先から外す", async () => {
  const { link } = setup([
    { id: "old-1", name: "pm1-cap", registered_at: "2026-11-03T05:00:00.000Z" },
    { id: "old-2", name: "pm1-cap", registered_at: "2026-11-03T05:00:10.000Z" },
  ]);
  await link.connect();
  const mark = { exclude: new Set(["old-1"]), since: "2026-11-03T05:00:10.000Z" };
  assert.deepEqual(await link.notifyPeer("pm1-cap", "x", { mark }), { ok: true, to: "old-2" });
  const stale = await link.notifyPeer("pm1-cap", "x", { mark: { exclude: new Set(["old-1"]), since: "2026-11-03T05:01:00.000Z" } });
  assert.equal(stale.ok, false);
  await link.close();
});

test("peerMarkOf: since は全 peer の最新の登録時刻、同名 peer の id が exclude に入る。列挙できなければ null", async () => {
  const { link } = setup([
    { id: "a", name: "pm1-cap", registered_at: "2026-11-03T05:00:00.000Z" },
    { id: "b", name: "other", registered_at: "2026-11-03T05:00:40.000Z" },
    { id: "center-1", name: "pm1-cap", registered_at: "2026-11-03T05:09:00.000Z" },
  ]);
  await link.connect();
  const m = await link.peerMarkOf("pm1-cap");
  assert.deepEqual([...(m?.exclude ?? [])], ["a"]);
  assert.equal(m?.since, "2026-11-03T05:00:40.000Z");
  await link.close();

  const n = setup(null);
  await n.link.connect();
  assert.equal(await n.link.peerMarkOf("pm1-cap"), null);
});

test("close 後の送信は投げる", async () => {
  const { link } = setup();
  await link.connect();
  await link.close();
  await assert.rejects(() => link.stop("srv", "pm1-cap"), /center 終了/);
});
