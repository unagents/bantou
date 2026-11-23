import assert from "node:assert/strict";
import { test } from "node:test";
import { createServerLink, type LinkClient, type LinkInbound, type LinkMeta, type LinkPeer } from "../src/server-link.js";
import { resolvePairServerVersion } from "../src/pair.js";

class FakeClient implements LinkClient {
  sent: Array<{ to: string; text: string; delivery?: string; meta?: LinkMeta }> = [];
  peers: LinkPeer[] = [];
  handler: Parameters<LinkClient["onMessage"]>[0] = () => {};
  failSend = false;
  peer = { id: "center-1" };
  async connect(): Promise<void> {}
  async close(): Promise<void> {}
  async send(to: string, text: string, delivery?: "pull" | "push", meta?: LinkMeta): Promise<unknown> {
    if (this.failSend) throw new Error("send failed");
    this.sent.push({ to, text, ...(delivery ? { delivery } : {}), ...(meta ? { meta } : {}) });
    return {};
  }
  async listPeers(): Promise<LinkPeer[]> {
    return this.peers;
  }
  onMessage(h: Parameters<LinkClient["onMessage"]>[0]): () => void {
    this.handler = h;
    return () => {};
  }
  inbound(m: Partial<LinkInbound> & { text: string }): void {
    void this.handler({ from_name: "x", ...m });
  }
}

const peer = (id: string, version: string | null): LinkPeer => ({
  id,
  name: `srv-${id}`,
  protocols: version === null ? [] : [{ name: "bantou", version }],
});

/** bridgeVersion = null: 組の版が不明（橋は送らない）。 */
function setup(peers: LinkPeer[], bridgeVersion: string | null = "0.7.0") {
  const client = new FakeClient();
  client.peers = peers;
  const logs: string[] = [];
  const link = createServerLink({
    name: "bantou-center-0123456789",
    log: (m) => logs.push(m),
    clientFactory: () => client,
    ...(bridgeVersion !== null ? { bridgeVersion } : {}),
  });
  return { link, client, logs };
}

const BODY = JSON.stringify({ bantou: 1, type: "update_server", version: "0.7.0" });
const META_1X = { protocol: "bantou", version: "1.8.1" };

test("bridgeLegacy: protocol 1.x の peer にだけ固定の形で update_server を送る（meta は bantou 1.8.1）。2.x・宣言なしには送らない", async () => {
  const { link, client } = setup([peer("a", "1.8.1"), peer("b", "2.0.0"), peer("c", null), peer("d", "1.2.0"), peer("center-1", "1.8.1")]);
  await link.connect();
  await link.bridgeLegacy();
  assert.deepEqual(client.sent, [
    { to: "a", text: BODY, delivery: "push", meta: META_1X },
    { to: "d", text: BODY, delivery: "push", meta: META_1X },
  ]);
  await link.close();
});

test("bridgeLegacy: 1 つの peer に送るのは 1 回だけ（起動中は覚える）。server_list を見ても、再度の bridgeLegacy でも増えない", async () => {
  const { link, client } = setup([peer("a", "1.8.1")]);
  await link.connect();
  await link.bridgeLegacy();
  await link.bridgeLegacy();
  await link.listServers();
  assert.equal(client.sent.length, 1);
  // 後から現れた 1.x の peer には、server_list を見た時に送る
  client.peers = [peer("a", "1.8.1"), peer("e", "1.8.1")];
  await link.listServers();
  assert.deepEqual(client.sent.map((s) => s.to), ["a", "e"]);
  await link.close();
});

test("listServers: 2.x だけなら何も送らない。一覧は従来どおり", async () => {
  const { link, client } = setup([peer("b", "2.0.0")]);
  await link.connect();
  const list = await link.listServers();
  assert.deepEqual(list.map((s) => s.protocol), ["2.0.0"]);
  assert.deepEqual(client.sent, []);
  await link.close();
});

test("bridgeLegacy: 組の版が無ければ送らない。送信失敗は投げず、再送もしない", async () => {
  const a = setup([peer("a", "1.8.1")], null);
  await a.link.connect();
  await a.link.bridgeLegacy();
  assert.deepEqual(a.client.sent, []);

  const b = setup([peer("a", "1.8.1")]);
  await b.link.connect();
  b.client.failSend = true;
  await b.link.bridgeLegacy();
  b.client.failSend = false;
  await b.link.bridgeLegacy();
  assert.deepEqual(b.client.sent, []);
  assert.ok(b.logs.some((l) => l.includes("移行の橋: 送れない")));
});

test("bridgeLegacy: 送った peer の返事（update_result / error）は log に書くだけ。版の控えには入れない。本文は載せない", async () => {
  const { link, client, logs } = setup([peer("a", "1.8.1")]);
  await link.connect();
  await link.bridgeLegacy();
  client.inbound({ from_name: "srv-a", text: JSON.stringify({ bantou: 1, type: "update_result", ok: true, state: "waiting", from: "0.6.12", to: "0.7.0", note: "SECRET-TOKEN" }) });
  client.inbound({ from_name: "srv-a", text: JSON.stringify({ bantou: 1, type: "error", code: "update_failed", message: "SECRET-TOKEN" }) });
  const lines = logs.filter((l) => l.includes("移行の橋: 返事"));
  assert.equal(lines.length, 2);
  assert.match(lines[0]!, /update_result ok=true state=waiting from=0\.6\.12 to=0\.7\.0/);
  assert.match(lines[1]!, /error code=update_failed/);
  assert.equal(logs.some((l) => l.includes("SECRET-TOKEN")), false);
  await link.close();
});

test("resolvePairServerVersion: env（埋め込み）が先、無ければ package.json。不正は無視、どちらも無ければ undefined", () => {
  const warns: string[] = [];
  assert.equal(resolvePairServerVersion({ envValue: "0.7.0", readPackage: () => "0.6.0" }), "0.7.0");
  assert.equal(resolvePairServerVersion({ envValue: undefined, readPackage: () => "0.6.0" }), "0.6.0");
  assert.equal(resolvePairServerVersion({ envValue: "v1", readPackage: () => "0.6.0", warn: (m) => warns.push(m) }), "0.6.0");
  assert.equal(warns.length, 1);
  assert.equal(resolvePairServerVersion({ envValue: "", readPackage: () => undefined }), undefined);
  assert.equal(resolvePairServerVersion({ envValue: undefined, readPackage: () => "bad" }), undefined);
});
