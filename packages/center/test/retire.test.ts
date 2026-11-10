import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { MESSENGER_PROTOCOL, RETIRE_EXIT_CODE } from "@agent-hand/bantou-protocol";
import { parseConfig } from "../src/config.js";
import { createRemoteManager, type RemoteRecord } from "../src/remotes.js";
import { retireServer } from "../src/retire.js";
import { createCenterServer } from "../src/server.js";
import { createServerLink, type LinkClient, type LinkInbound, type LinkMeta, type LinkPeer, type ServerLink, type ServerPeer } from "../src/server-link.js";
import { createJsonListStore } from "../src/store.js";
import type { RemoteControlSupervisor } from "../src/remote-control.js";
import type { SessionManager } from "../src/sessions.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "center-ret-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
});

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 15));

// -- 実 link + 偽 client: retire_server の送受信 --

class FakeClient implements LinkClient {
  sent: Array<{ to: string; msg: Record<string, unknown> }> = [];
  peers: LinkPeer[] = [];
  handler: Parameters<LinkClient["onMessage"]>[0] = () => {};
  peer = { id: "center-1" };
  /** peer id → type ごとの返信。 */
  replies = new Map<string, Record<string, Record<string, unknown>>>();
  async connect(): Promise<void> {}
  async close(): Promise<void> {}
  async send(to: string, text: string, _d?: "pull" | "push", meta?: LinkMeta): Promise<unknown> {
    if (!meta) return {};
    const msg = JSON.parse(text) as Record<string, unknown>;
    this.sent.push({ to, msg });
    const reply = this.replies.get(to)?.[msg.type as string];
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

const lp = (id: string, hostname = "lenovo", version = MESSENGER_PROTOCOL.version): LinkPeer => ({ id, name: "bantou-server", hostname, protocols: [{ name: "bantou", version }] });
const hello = (id: { server_id: string; host: string; user: string; workspace: string }, protocol_version: string | null = MESSENGER_PROTOCOL.version) => ({
  bantou: 1, type: "hello_result", ok: true, server_version: "0.1.42", ...(protocol_version !== null ? { protocol_version } : {}), update: null, last_update: null, ...id,
});
const A = { server_id: "srv-aaaaaaaaaa", host: "lenovo", user: "bantou-a", workspace: "/srv/a" };
const B = { server_id: "srv-bbbbbbbbbb", host: "lenovo", user: "bantou-b", workspace: "/srv/b" };
const retireOk = (id = A) => ({
  bantou: 1, type: "retire_result", ok: true, state: "retiring", stopped: { caps: 2, workers: 3 }, exit_at: "2026-11-10T09:00:03.000Z", exit_code: RETIRE_EXIT_CODE,
  host_steps: ["systemctl disable --now bantou-server.service", "userdel bantou-a", "rm -rf /srv/a"], service: { manager: "systemd", name: "bantou-server.service", detected: true }, ...id,
});

function linkWith(c: FakeClient) {
  return createServerLink({ config: parseConfig({}, "/x/c.json"), log: () => {}, clientFactory: () => c, identifyTimeoutMs: 40 });
}

test("link.retireOn: retire_server を server_id 付きで送り retire_result を返す。版が違う peer にも送れる（control）", async () => {
  const c = new FakeClient();
  c.peers = [lp("p-a", "lenovo", "1.8.0")];
  c.replies.set("p-a", { retire_server: retireOk() });
  const link = linkWith(c);
  const peer: ServerPeer = { id: "p-a", name: "bantou-server", version: "1.5.0" }; // center の版と違う
  const r = await link.retireOn(peer, { server_id: A.server_id, reason: "不要" });
  assert.equal(r.type, "retire_result");
  const sent = c.sent.find((s) => s.msg.type === "retire_server")!;
  assert.deepEqual(sent.msg, { bantou: sent.msg.bantou, type: "retire_server", server_id: A.server_id, reason: "不要" });
  await link.close();
});

test("link.retireOn: error{retiring:true} をそのまま返す。markRetired した peer は発見から外れ、selectPeer にも出ない", async () => {
  const c = new FakeClient();
  c.peers = [lp("p-a"), lp("p-b")];
  c.replies.set("p-a", { retire_server: { bantou: 1, type: "error", ok: false, message: "退役中", command: "retire_server", retiring: true, retryable: false }, hello: hello(A) });
  c.replies.set("p-b", { hello: hello(B) });
  const link = linkWith(c);
  const r = await link.retireOn({ id: "p-a", name: "bantou-server" }, { server_id: A.server_id });
  assert.equal(r.type, "error");
  assert.equal(r.type === "error" && r.retiring, true);
  assert.equal((await link.peers()).length, 2);
  link.markRetired("p-a");
  assert.deepEqual((await link.peers()).map((p) => p.id), ["p-b"]);
  await assert.rejects(link.selectPeer("p-a"), /server が見つからない/);
  await link.close();
});

// -- retireServer（tool の本体） --

function fakeDeps(over: { hello?: unknown; retire?: unknown; selectPeer?: () => Promise<ServerPeer> } = {}) {
  const calls = { retire: [] as unknown[], marked: [] as string[], forgot: [] as unknown[] };
  const peer: ServerPeer = { id: "p-a", name: "bantou-server", hostname: "lenovo", ...A };
  const link = {
    selectPeer: over.selectPeer ?? (async () => peer),
    hello: async () => over.hello ?? hello(A),
    retireOn: async (_p: ServerPeer, cmd: unknown) => {
      calls.retire.push(cmd);
      return over.retire ?? retireOk();
    },
    markRetired: (id: string) => calls.marked.push(id),
  } as unknown as ServerLink;
  const remotes = { forgetServer: async (t: unknown) => (calls.forgot.push(t), { removed: 2, sessions: ["pm1", "pm2"] }) };
  return { deps: { link, remotes, log: () => {} }, calls };
}

test("retireServer: 版の門 — protocol 1.7.0 の server へは retire_server を送らない（未対応の理由付きエラー）。記録も消さない", async () => {
  const { deps, calls } = fakeDeps({ hello: hello(A, "1.7.0") });
  await assert.rejects(retireServer(deps, { server: "lenovo" }), /退役に未対応（protocol 1\.7\.0.*host で手動で止める/);
  assert.equal(calls.retire.length, 0);
  assert.equal(calls.marked.length, 0);
  assert.equal(calls.forgot.length, 0);
});

test("retireServer: 版不明（hello_result に protocol_version が無い）・hello が error（hello を知らない旧 server）でも送らない", async () => {
  const noVer = fakeDeps({ hello: hello(A, null) });
  await assert.rejects(retireServer(noVer.deps, { server: "x" }), /退役に未対応（protocol 不明/);
  assert.equal(noVer.calls.retire.length, 0);
  const helloErr = fakeDeps({ hello: { bantou: 1, type: "error", ok: false, message: "タイムアウト (10000ms)", command: "hello" } });
  await assert.rejects(retireServer(helloErr.deps, { server: "x" }), /版を確認できず、退役を送らない.*host で手動で止める/);
  assert.equal(helloErr.calls.retire.length, 0);
});

test("retireServer: 1.8.0 の server へ server_id 付きで送り、retire_result の host_steps / service / stopped / exit_at を返す。peer を退役済みにして記録を消す", async () => {
  const { deps, calls } = fakeDeps();
  const r = await retireServer(deps, { server: A.server_id, reason: "lenovo 整理" });
  assert.deepEqual(calls.retire, [{ server_id: A.server_id, reason: "lenovo 整理" }]);
  assert.equal(r.state, "retiring");
  assert.deepEqual(r.stopped, { caps: 2, workers: 3 });
  assert.equal(r.exit_at, "2026-11-10T09:00:03.000Z");
  assert.equal(r.exit_code, 76);
  assert.equal(r.host_steps?.length, 3);
  assert.deepEqual(r.service, { manager: "systemd", name: "bantou-server.service", detected: true });
  assert.deepEqual([r.server_id, r.host, r.user, r.workspace, r.peer], [A.server_id, "lenovo", "bantou-a", "/srv/a", "p-a"]);
  assert.deepEqual([r.records_removed, r.sessions], [2, ["pm1", "pm2"]]);
  assert.deepEqual(calls.marked, ["p-a"]);
  assert.deepEqual(calls.forgot, [{ server_id: A.server_id, peerId: "p-a" }]);
});

test("retireServer: error{retiring:true} は「既に退役中」の結果（記録は片付ける）", async () => {
  const { deps, calls } = fakeDeps({ retire: { bantou: 1, type: "error", ok: false, message: "retiring", command: "retire_server", retiring: true, retryable: false } });
  const r = await retireServer(deps, { server: "lenovo" });
  assert.equal(r.state, "already_retiring");
  assert.match(r.message, /既に退役中/);
  assert.equal(r.host_steps, undefined);
  assert.equal(calls.forgot.length, 1);
});

test("retireServer: 無返信（timeout）・別の error は退役したと見なさない。peer も記録もそのまま", async () => {
  for (const retire of [
    { bantou: 1, type: "error", ok: false, message: "タイムアウト (60000ms)", command: "retire_server" },
    { bantou: 1, type: "error", ok: false, message: "server_id が違う", command: "retire_server" },
  ]) {
    const { deps, calls } = fakeDeps({ retire });
    await assert.rejects(retireServer(deps, { server: "lenovo" }), /retire_result）を受け取れなかった.*退役したとは限らない/);
    assert.equal(calls.marked.length, 0);
    assert.equal(calls.forgot.length, 0);
  }
});

test("retireServer: 同じ host に server が 2 つ — host 名指定は曖昧エラー（user と workspace 付き）で何も送らない。server_id なら片方だけ", async () => {
  const c = new FakeClient();
  c.peers = [lp("p-a"), lp("p-b")];
  for (const [id, who] of [["p-a", A], ["p-b", B]] as const) c.replies.set(id, { hello: hello(who), retire_server: retireOk(who) });
  const link = linkWith(c);
  const forgot: unknown[] = [];
  const deps = { link, remotes: { forgetServer: async (t: unknown) => (forgot.push(t), { removed: 0, sessions: [] }) }, log: () => {} };
  await assert.rejects(retireServer(deps, { server: "lenovo" }), (e: Error) => /曖昧/.test(e.message) && /user=bantou-a/.test(e.message) && /workspace=\/srv\/b/.test(e.message));
  assert.equal(c.sent.filter((s) => s.msg.type === "retire_server").length, 0);
  const r = await retireServer(deps, { server: B.server_id });
  assert.equal(r.server_id, B.server_id);
  const sent = c.sent.filter((s) => s.msg.type === "retire_server");
  assert.deepEqual(sent.map((s) => [s.to, s.msg.server_id]), [["p-b", B.server_id]]);
  assert.deepEqual(forgot, [{ server_id: B.server_id, peerId: "p-b" }]);
  // 退役した B は発見から外れ、A だけが残る
  assert.deepEqual((await link.peers()).map((p) => p.id), ["p-a"]);
  await link.close();
});

// -- 記録の整理: 退役した server の cap の記録だけが消え、peer が消えても unknown の記録が残らない --

const peerAA: ServerPeer = { id: "p-a", name: "bantou-server", hostname: "lenovo", ...A };
const peerBB: ServerPeer = { id: "p-b", name: "bantou-server", hostname: "lenovo", ...B };

function remotesWith(peers: ServerPeer[]) {
  let live = peers;
  const link = {
    peers: async () => live,
    selectPeer: async (sel?: string) => {
      const hit = sel === undefined ? live : live.filter((p) => p.server_id === sel || p.id === sel || p.host === sel);
      if (hit.length === 0) throw new Error(`server が見つからない: ${sel}`);
      if (hit.length > 1) throw new Error(`曖昧: ${sel}`);
      return hit[0];
    },
    statusOn: async () => ({ bantou: 1, type: "status_result", ok: true, caps: [], workers: [] }),
    taskOn: () => new Promise(() => {}),
    stopCapOn: async (_p: ServerPeer, cmd: { cap_id: string }) => ({ bantou: 1, type: "stop_result", ok: true, cap_id: cmd.cap_id, stopped: true }),
  } as unknown as ServerLink;
  const store = createJsonListStore<RemoteRecord>(join(dir, "remotes.json"), () => {});
  return { mgr: createRemoteManager({ link, store, log: () => {}, capId: "c-0123456789", graceMs: 60, pollMs: 40 }), setLive: (p: ServerPeer[]) => (live = p) };
}

test("forgetServer: 退役した server の記録（session × server）だけ消える。別の server の記録は残り、保存される。peer が消えても unknown の記録は残らない", async () => {
  const { mgr, setLive } = remotesWith([peerAA, peerBB]);
  await mgr.send({ owner: "pm1", goal: "a", server: A.server_id });
  await mgr.send({ owner: "pm2", goal: "a", server: A.server_id });
  await mgr.send({ owner: "pm1", goal: "b", server: B.server_id });
  assert.equal(mgr.list().length, 3);
  const gone = await mgr.forgetServer({ server_id: A.server_id, peerId: "p-a" });
  assert.equal(gone.removed, 2);
  assert.deepEqual(gone.sessions.sort(), ["pm1", "pm2"]);
  setLive([peerBB]); // A の peer は発見から消える
  await mgr.prune();
  const left = mgr.list();
  assert.deepEqual(left.map((r) => [r.session, r.server_id, r.state]), [["pm1", B.server_id, "running"]]);
  assert.ok(left.every((r) => r.state !== "unknown"));
  const saved = JSON.parse(await readFile(join(dir, "remotes.json"), "utf8")) as RemoteRecord[];
  assert.deepEqual(saved.map((r) => r.server_id), [B.server_id]);
  assert.deepEqual(await mgr.forgetServer({ server_id: "srv-none", peerId: "zz" }), { removed: 0, sessions: [] });
});

test("forgetServer: server_id の無い旧形式の記録は到達先（peer id）が一致する時だけ消える。別の server_id の記録は peer id が同じでも消さない", async () => {
  const old: ServerPeer = { id: "p-old", name: "bantou-server", hostname: "old-host" };
  const { mgr } = remotesWith([old, peerAA]);
  await mgr.send({ owner: "pm1", goal: "x", server: "p-old" });
  await mgr.send({ owner: "pm1", goal: "y", server: A.server_id });
  assert.equal((await mgr.forgetServer({ server_id: B.server_id, peerId: "p-old" })).removed, 1, "旧形式（server_id 無し）は peer id 一致で消える");
  assert.deepEqual(mgr.list().map((r) => r.server_id), [A.server_id]);
  assert.equal((await mgr.forgetServer({ server_id: B.server_id, peerId: "p-a" })).removed, 0, "別の server_id の記録は peer id が同じでも消さない");
});

// -- tool server_retire --

async function toolClient(link: Partial<ServerLink>, remotes: unknown) {
  const supervisor = { list: () => [], shutdown: async () => {} } as unknown as RemoteControlSupervisor;
  const server = createCenterServer({ config: parseConfig({}, "/x/c.json"), supervisor, link: link as ServerLink, sessions: {} as SessionManager, remotes: remotes as never, log: () => {} });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "0" });
  await Promise.all([server.connect(st), client.connect(ct)]);
  return client;
}

test("tool server_retire: server は必須。成功は JSON、未対応・曖昧・無返信は isError", async () => {
  const { deps } = fakeDeps();
  const client = await toolClient(deps.link, deps.remotes);
  const ok = await client.callTool({ name: "server_retire", arguments: { server: A.server_id } });
  assert.ok(!ok.isError);
  const body = JSON.parse((ok.content as { text: string }[])[0].text);
  assert.equal(body.state, "retiring");
  assert.equal(body.host_steps.length, 3);
  assert.equal(body.records_removed, 2);
  const noArg = await client.callTool({ name: "server_retire", arguments: {} });
  assert.equal(noArg.isError, true);

  const old = fakeDeps({ hello: hello(A, "1.7.0") });
  const c2 = await toolClient(old.deps.link, old.deps.remotes);
  const bad = await c2.callTool({ name: "server_retire", arguments: { server: "lenovo" } });
  assert.equal(bad.isError, true);
  assert.match((bad.content as { text: string }[])[0].text, /退役に未対応（protocol 1\.7\.0/);
  assert.equal(old.calls.retire.length, 0);

  const amb = fakeDeps({ selectPeer: async () => { throw new Error("server の指定が曖昧: lenovo は 2 件の server に一致する"); } });
  const c3 = await toolClient(amb.deps.link, amb.deps.remotes);
  const r3 = await c3.callTool({ name: "server_retire", arguments: { server: "lenovo" } });
  assert.equal(r3.isError, true);
  assert.match((r3.content as { text: string }[])[0].text, /曖昧/);
  await tick();
});
