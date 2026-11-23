import assert from "node:assert/strict";
import { test } from "node:test";
import { MESSENGER_PROTOCOL, type ServerNotice } from "@agent-hand/bantou-protocol";
import { parseConfig } from "../src/config.js";
import { createServerLink, type LinkClient, type LinkInbound, type LinkMeta, type LinkPeer } from "../src/server-link.js";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

class FakeClient implements LinkClient {
  sent: Record<string, unknown>[] = [];
  peers: LinkPeer[] = [{ id: "id-a", name: "bantou-server", protocols: [{ name: "bantou", version: MESSENGER_PROTOCOL.version }] }];
  handler: Parameters<LinkClient["onMessage"]>[0] = () => {};
  peer = { id: "peer-1" };
  async connect(): Promise<void> {}
  async close(): Promise<void> {}
  async send(_to: string, text: string, _d?: "pull" | "push", meta?: LinkMeta): Promise<unknown> {
    if (meta) this.sent.push(JSON.parse(text) as Record<string, unknown>);
    return {};
  }
  async listPeers(): Promise<LinkPeer[]> {
    return this.peers;
  }
  onMessage(h: Parameters<LinkClient["onMessage"]>[0]): () => void {
    this.handler = h;
    return () => {};
  }
  reply(obj: object, extra: Partial<LinkInbound> = {}): void {
    void this.handler({ from_name: "bantou-server", from_id: "id-a", text: JSON.stringify(obj), ...extra });
  }
}

function setup(onNotice?: (n: ServerNotice) => void) {
  const clients: FakeClient[] = [];
  const link = createServerLink({
    config: parseConfig({}, "/x/c.json"),
    log: () => {},
    clientFactory: () => {
      const c = new FakeClient();
      clients.push(c);
      return c;
    },
    healthCheck: async () => true,
    onNotice,
  });
  const peer = { id: "id-a", name: "bantou-server", version: MESSENGER_PROTOCOL.version };
  return { link, clients, peer };
}

const V = { bantou: 1 };
const regCmd = (id: string) => ({ change_id: id, scope: ["a", "b"], repo: "https://x/y.git", notify_id: "c-0123456789-pm1" });

test("registerChangeOn: register_change を送り、change_id が一致する register_change_result だけで解決する", async () => {
  const { link, clients, peer } = setup();
  const p = link.registerChangeOn(peer, regCmd("ch-1"));
  await sleep(20);
  assert.deepEqual(clients[0].sent[0], { ...V, type: "register_change", ...regCmd("ch-1") });
  clients[0].reply({ ...V, type: "register_change_result", ok: true, change_id: "ch-other", accepted: true, state: "in_progress" });
  clients[0].reply({ ...V, type: "register_change_result", ok: true, change_id: "ch-1", accepted: true, state: "in_progress" });
  const r = await p;
  assert.deepEqual([r.type, (r as { change_id: string }).change_id], ["register_change_result", "ch-1"]);
  await link.close();
});

test("registerChangeOn: change_id 付きの error は同じ change_id の待ちだけを解決する（別 change の待ちは残る）", async () => {
  const { link, clients, peer } = setup();
  const a = link.registerChangeOn(peer, regCmd("ch-a"));
  const b = link.registerChangeOn(peer, regCmd("ch-b"));
  await sleep(30);
  clients[0].reply({ ...V, type: "error", ok: false, message: "登録済み", command: "register_change", change_id: "ch-b" });
  const rb = await b;
  assert.deepEqual([rb.type, (rb as { message: string }).message], ["error", "登録済み"]);
  clients[0].reply({ ...V, type: "register_change_result", ok: true, change_id: "ch-a", accepted: true, state: "in_progress" });
  assert.equal((await a).type, "register_change_result");
  await link.close();
});

test("workerReplyOn（change_id）/ workerStopOn: cap_id か change_id と worker_id で解決する。error（worker_id 付き）を cap の worker_result の待ちと取り違えない", async () => {
  const { link, clients, peer } = setup();
  const p = link.workerReplyOn(peer, { change_id: "ch-1", worker_id: "w-1", text: "OK" });
  await sleep(20);
  assert.deepEqual(clients[0].sent[0], { ...V, type: "worker_reply", change_id: "ch-1", worker_id: "w-1", text: "OK" });
  clients[0].reply({ ...V, type: "worker_reply_result", ok: true, change_id: "ch-1", worker_id: "w-2", accepted: true });
  clients[0].reply({ ...V, type: "worker_reply_result", ok: true, change_id: "ch-1", worker_id: "w-1", accepted: true });
  assert.equal(((await p) as { worker_id: string }).worker_id, "w-1");
  const q = link.workerReplyOn(peer, { change_id: "ch-1", worker_id: "w-1", text: "NG" });
  await sleep(20);
  clients[0].reply({ ...V, type: "error", ok: false, message: "返答待ちでない", command: "worker_reply", change_id: "ch-1", worker_id: "w-1" });
  const e = await q;
  assert.deepEqual([e.type, (e as { message: string }).message], ["error", "返答待ちでない"]);
  // cap の worker の返答は今のまま cap_id:worker_id
  const c = link.workerReplyOn(peer, { cap_id: "c-1", worker_id: "w-1", text: "x" });
  await sleep(20);
  clients[0].reply({ ...V, type: "worker_reply_result", ok: true, change_id: "c-1", worker_id: "w-1", accepted: true });
  clients[0].reply({ ...V, type: "worker_reply_result", ok: true, cap_id: "c-1", worker_id: "w-1", accepted: true });
  assert.equal(((await c) as { cap_id?: string }).cap_id, "c-1");

  const s = link.workerStopOn(peer, { change_id: "ch-1", worker_id: "w-1" });
  await sleep(20);
  assert.deepEqual(clients[0].sent.at(-1), { ...V, type: "worker_stop", change_id: "ch-1", worker_id: "w-1" });
  clients[0].reply({ ...V, type: "worker_stop_result", ok: true, change_id: "ch-1", worker_id: "w-2", stopped: true });
  clients[0].reply({ ...V, type: "worker_stop_result", ok: true, change_id: "ch-1", worker_id: "w-1", stopped: true });
  assert.deepEqual([(await s).type, ((await s) as { stopped: boolean }).stopped], ["worker_stop_result", true]);
  const u = link.workerStopOn(peer, { cap_id: "c-1", worker_id: "w-1", task_id: "t-1" });
  await sleep(20);
  clients[0].reply({ ...V, type: "error", ok: false, message: "止められない", command: "worker_stop", cap_id: "c-1", worker_id: "w-1" });
  assert.equal(((await u) as { message: string }).message, "止められない");
  await link.close();
});

test("通知: worker_report（change_id つき）/ change_progress は onNotice へ渡る（待ちは消えない）", async () => {
  const got: ServerNotice[] = [];
  const { link, clients, peer } = setup((n) => got.push(n));
  const p = link.registerChangeOn(peer, regCmd("ch-1"));
  await sleep(20);
  clients[0].reply({ ...V, type: "worker_report", change_id: "ch-1", worker_id: "w-1", kind: "ask", text: "?", at: "2026-11-23T00:00:00Z" });
  clients[0].reply({ ...V, type: "change_progress", notify_id: "c-0123456789-pm1", change_id: "ch-1", step: 1, change_state: "completed", step_state: "passed", at: "2026-11-23T00:00:01Z" });
  assert.deepEqual(got.map((n) => n.type), ["worker_report", "change_progress"]);
  clients[0].reply({ ...V, type: "register_change_result", ok: true, change_id: "ch-1", accepted: true, state: "in_progress" });
  assert.equal((await p).type, "register_change_result");
  await link.close();
});
