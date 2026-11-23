import assert from "node:assert/strict";
import { test } from "node:test";
import type { ChangeInfo, ChangeReportNotice, ChangeProgressNotice } from "@agent-hand/bantou-protocol";
import { createChangeManager, type ChangeRecord } from "../src/changes.js";
import { registerChangeTools } from "../src/change-tools.js";
import type { ServerLink, ServerPeer } from "../src/server-link.js";

const CAP = "c-0123456789";
const peerA: ServerPeer = { id: "id-a", name: "bantou-server", hostname: "host-a", version: "1.9.0", server_id: "srv-a" };
const peerB: ServerPeer = { id: "id-b", name: "bantou-server", hostname: "host-b", version: "1.9.0", server_id: "srv-b" };
const V = { bantou: 1 };
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 10));

function setup(opts: { serversOf?: (o: string) => string[] | undefined; peers?: ServerPeer[] } = {}) {
  const calls: Array<{ fn: string; peer: string; cmd?: unknown }> = [];
  const st = {
    registerReply: undefined as unknown,
    statusReply: undefined as unknown,
    stopReply: undefined as unknown,
    replyReply: undefined as unknown,
    statusDown: false,
  };
  const peers = opts.peers ?? [peerA];
  const link = {
    peers: async () => peers,
    identifiedPeers: async () => peers,
    selectPeer: async (sel?: string) => {
      const p = sel === undefined ? peers[0] : peers.find((x) => x.server_id === sel || x.id === sel || x.hostname === sel);
      if (!p) throw new Error(`server が見つからない: ${sel}`);
      return p;
    },
    identityOf: (id: string) => peers.find((p) => p.id === id),
    registerChangeOn: async (p: ServerPeer, cmd: { change_id: string }) => {
      calls.push({ fn: "register", peer: p.id, cmd });
      return st.registerReply ?? { ...V, type: "register_change_result", ok: true, change_id: cmd.change_id, accepted: true, state: "in_progress" };
    },
    changeStatusOn: async (p: ServerPeer, cmd?: { change_id?: string }) => {
      calls.push({ fn: "status", peer: p.id, cmd });
      if (st.statusDown) return { ...V, type: "error", ok: false, message: "返信が来ない", transport: true };
      return st.statusReply ?? { ...V, type: "change_status_result", ok: true, changes: [] };
    },
    stopChangeOn: async (p: ServerPeer, cmd: { change_id: string }) => {
      calls.push({ fn: "stop", peer: p.id, cmd });
      return st.stopReply ?? { ...V, type: "stop_change_result", ok: true, change_id: cmd.change_id, stopped: true };
    },
    changeReplyOn: async (p: ServerPeer, cmd: { change_id: string; worker_id: string }) => {
      calls.push({ fn: "reply", peer: p.id, cmd });
      return st.replyReply ?? { ...V, type: "change_reply_result", ok: true, change_id: cmd.change_id, worker_id: cmd.worker_id, accepted: true };
    },
  } as unknown as ServerLink;
  let saved: ChangeRecord[] = [];
  const store = { load: async () => saved, save: async (x: ChangeRecord[]) => void (saved = JSON.parse(JSON.stringify(x)) as ChangeRecord[]) };
  const notified: Array<{ owner: string; text: string }> = [];
  const mgr = createChangeManager({
    link,
    store,
    log: () => {},
    capId: CAP,
    ...(opts.serversOf ? { serversOf: opts.serversOf } : {}),
    notify: async (owner, text) => {
      notified.push({ owner, text });
      return { ok: true };
    },
  });
  return { mgr, calls, st, store, notified, saved: () => saved };
}

const reg = (o = "pm1", id = "ch-1") => ({ owner: o, change_id: id, scope: ["s1", "s2"], repo: "https://x/y.git" });
const report = (over: Partial<ChangeReportNotice> = {}): ChangeReportNotice => ({
  ...V, type: "change_report", notify_id: `${CAP}-pm1`, change_id: "ch-1", worker_id: "w-1", step: 0, kind: "ask", text: "どうする？", at: "2026-11-23T00:00:00Z", ...over,
}) as ChangeReportNotice;
const progress = (over: Partial<ChangeProgressNotice> = {}): ChangeProgressNotice => ({
  ...V, type: "change_progress", notify_id: `${CAP}-pm1`, change_id: "ch-1", step: 1, change_state: "completed", step_state: "passed", at: "2026-11-23T00:01:00Z", ...over,
}) as ChangeProgressNotice;
const info = (state: ChangeInfo["state"], id = "ch-1"): ChangeInfo => ({ change_id: id, state, step: 0, steps: [{ ref: "s1", state: "running", worker_id: "w-1" }], updated_at: "2026-11-23T00:00:00Z" });

test("register: notify_id（<center の cap_id>-<session>）を付けて server へ送り、記録を保存する。server は選んだ peer", async () => {
  const t = setup();
  const r = await t.mgr.register({ ...reg(), branch: "b1", worker_model: "sonnet" });
  assert.deepEqual([r.change_id, r.server, r.state, r.accepted, r.notify_id], ["ch-1", "srv-a", "in_progress", true, `${CAP}-pm1`]);
  assert.deepEqual(t.calls[0].cmd, { change_id: "ch-1", scope: ["s1", "s2"], repo: "https://x/y.git", branch: "b1", worker_model: "sonnet", notify_id: `${CAP}-pm1` });
  assert.equal(t.saved().length, 1);
  assert.equal(t.saved()[0].session, "pm1");
});

test("register: server の error は投げる（記録は作らない）", async () => {
  const t = setup();
  t.st.registerReply = { ...V, type: "error", ok: false, message: "change は in_progress の間は再登録できない" };
  await assert.rejects(t.mgr.register(reg()), /再登録できない/);
  assert.equal(t.mgr.list({ owner: "pm1" }).length, 0);
});

test("register: 再登録は前の登録の server へ送り、同じ change_id の記録（質問・通知の写し）を置き換える", async () => {
  const t = setup({ peers: [peerA, peerB] });
  await t.mgr.register({ ...reg(), server: "srv-b" });
  t.mgr.onChangeReport(report());
  t.mgr.onChangeProgress(progress({ change_state: "stopped", step_state: "stopped" }));
  assert.equal(t.mgr.list({ owner: "pm1" })[0].state, "stopped");
  await t.mgr.register(reg());
  assert.equal(t.calls[1].peer, "id-b");
  const l = t.mgr.list({ owner: "pm1" });
  assert.equal(l.length, 1);
  assert.deepEqual([l[0].state, l[0].asks.length, l[0].progress], ["in_progress", 0, undefined]);
});

test("register: session の servers の範囲外の server は断る。範囲内だけが既定の候補", async () => {
  const t = setup({ peers: [peerA, peerB], serversOf: () => ["host-b"] });
  await assert.rejects(t.mgr.register({ ...reg(), server: "srv-a" }), /servers に無い/);
  const r = await t.mgr.register(reg());
  assert.equal(r.server, "srv-b");
});

test("change_report: 返答待ちの質問を記録し、owner へ push する。wait が起きる。同じ worker の前の質問は解消", async () => {
  const t = setup();
  await t.mgr.register(reg());
  const w = t.mgr.wait({ owner: "pm1", change_id: "ch-1", timeoutSec: 5 });
  await tick();
  t.mgr.onChangeReport(report({ text: "q1" }), "id-a");
  const v = await w;
  assert.deepEqual([v.waiting_reply, v.asks[0].text, v.state], [1, "q1", "in_progress"]);
  assert.equal(t.notified.length, 1);
  assert.equal(t.notified[0].owner, "pm1");
  assert.match(t.notified[0].text, /change_report change_id=ch-1 step=0 worker=w-1 kind=ask/);
  t.mgr.onChangeReport(report({ text: "q2", at: "2026-11-23T00:00:05Z" }), "id-a");
  const l = t.mgr.list({ owner: "pm1" })[0];
  assert.deepEqual([l.waiting_reply, l.asks.length, l.asks[0].superseded_at], [1, 2, "2026-11-23T00:00:05Z"]);
});

test("change_report: 記録の無い notify_id・change_id は捨てる（push しない）", async () => {
  const t = setup();
  await t.mgr.register(reg());
  t.mgr.onChangeReport(report({ notify_id: `${CAP}-other` }));
  t.mgr.onChangeReport(report({ change_id: "ch-zzz" }));
  assert.equal(t.mgr.list({ owner: "pm1" })[0].asks.length, 0);
  assert.equal(t.notified.length, 0);
});

test("change_report: 登録した server と別の server から届いた同じ change_id の通知は取り違えず捨てる", async () => {
  const t = setup({ peers: [peerA, peerB] });
  await t.mgr.register({ ...reg(), server: "srv-a" });
  t.mgr.onChangeReport(report(), "id-b");
  t.mgr.onChangeProgress(progress(), "id-b");
  const l = t.mgr.list({ owner: "pm1" })[0];
  assert.deepEqual([l.asks.length, l.progress, l.peer], [0, undefined, "id-a"]);
  assert.equal(t.notified.length, 0);
  t.mgr.onChangeReport(report(), "id-a");
  assert.equal(t.mgr.list({ owner: "pm1" })[0].asks.length, 1);
});

test("change_progress: completed / stopped を記録し wait を起こす。未返答の質問は解消。push する", async () => {
  const t = setup();
  await t.mgr.register(reg());
  t.mgr.onChangeReport(report());
  const w = t.mgr.wait({ owner: "pm1", timeoutSec: 5 });
  // 質問が出ているので、wait は待たずに返る
  assert.equal((await w).waiting_reply, 1);
  t.mgr.onChangeProgress(progress({ reason: "stop_change" }), "id-a");
  const v = t.mgr.list({ owner: "pm1" })[0];
  assert.deepEqual([v.state, v.waiting_reply, v.progress?.reason], ["completed", 0, "stop_change"]);
  assert.match(t.notified[1].text, /change_progress change_id=ch-1 step=1 change=completed step_state=passed reason=stop_change/);
  assert.equal((await t.mgr.wait({ owner: "pm1", change_id: "ch-1", timeoutSec: 5 })).state, "completed");
  assert.equal(t.saved()[0].progress?.change_state, "completed");
});

test("wait: change が無い・in_progress が無いと投げる。timeout は今の記録を返す", async () => {
  const t = setup();
  await assert.rejects(t.mgr.wait({ owner: "pm1", change_id: "ch-1" }), /未定義/);
  await assert.rejects(t.mgr.wait({ owner: "pm1" }), /in_progress の change が無い/);
  await t.mgr.register(reg());
  const w = t.mgr.wait({ owner: "pm1", timeoutSec: 1 });
  const v = await w;
  assert.deepEqual([v.state, v.waiting_reply], ["in_progress", 0]);
});

test("reply: server へ送り、返答待ちだった質問に replied_at を付ける。server の error は投げ、質問は返答待ちのまま", async () => {
  const t = setup();
  await t.mgr.register(reg());
  t.mgr.onChangeReport(report());
  t.st.replyReply = { ...V, type: "error", ok: false, message: "worker が返答待ちでない", command: "change_reply", change_id: "ch-1" };
  await assert.rejects(t.mgr.reply({ owner: "pm1", change_id: "ch-1", worker_id: "w-1", text: "こう" }), /返答待ちでない/);
  assert.equal(t.mgr.list({ owner: "pm1" })[0].waiting_reply, 1);
  t.st.replyReply = undefined;
  const r = await t.mgr.reply({ owner: "pm1", change_id: "ch-1", worker_id: "w-1", text: "こう" });
  assert.deepEqual(r, { change_id: "ch-1", worker_id: "w-1", accepted: true });
  assert.deepEqual(t.calls.at(-1)?.cmd, { change_id: "ch-1", worker_id: "w-1", text: "こう" });
  assert.equal(t.mgr.list({ owner: "pm1" })[0].waiting_reply, 0);
  await assert.rejects(t.mgr.reply({ owner: "pm1", change_id: "ch-1", worker_id: "w-1", text: "a\0b" }), /不正/);
});

test("status: server の写しで記録を更新し（通知の写しは捨てる）、owner の change だけ返す。届かない時は error を付けて写しのまま", async () => {
  const t = setup();
  await t.mgr.register(reg("pm1", "ch-1"));
  await t.mgr.register(reg("pm2", "ch-2"));
  t.mgr.onChangeProgress(progress({ change_state: "stopped", step_state: "stopped" }));
  t.st.statusReply = { ...V, type: "change_status_result", ok: true, changes: [info("in_progress", "ch-1"), info("in_progress", "ch-2")], board: { queued: 2 } };
  const r = await t.mgr.status({ owner: "pm1" });
  assert.deepEqual(r.changes.map((c) => [c.change_id, c.state]), [["ch-1", "in_progress"]]);
  assert.deepEqual(r.boards, [{ server: "srv-a", board: { queued: 2 } }]);
  assert.equal(t.mgr.list({ owner: "pm1" })[0].progress, undefined);
  t.st.statusDown = true;
  const down = await t.mgr.status({ owner: "pm1", change_id: "ch-1" });
  assert.deepEqual([down.changes[0].error, down.changes[0].info?.state], ["返信が来ない", "in_progress"]);
});

test("stop: server へ送る。他の session の change は見えない（止められない）", async () => {
  const t = setup();
  await t.mgr.register(reg("pm1", "ch-1"));
  assert.deepEqual(await t.mgr.stop({ owner: "pm1", change_id: "ch-1" }), { change_id: "ch-1", stopped: true });
  await assert.rejects(t.mgr.stop({ owner: "pm2", change_id: "ch-1" }), /未定義の change/);
  assert.equal(t.mgr.list({ owner: "pm2" }).length, 0);
  t.st.stopReply = { ...V, type: "error", ok: false, message: "worker を止められなかった w-1", command: "stop_change", change_id: "ch-1" };
  await assert.rejects(t.mgr.stop({ owner: "pm1", change_id: "ch-1" }), /止められなかった/);
});

test("restore: 保存した記録を読み戻す", async () => {
  const t = setup();
  await t.mgr.register(reg());
  t.mgr.onChangeReport(report());
  const t2 = setup();
  await t2.store.save(t.saved());
  await t2.mgr.restore();
  assert.equal(t2.mgr.list({ owner: "pm1" })[0].waiting_reply, 1);
});

// -- tool --
type Handler = (args: Record<string, unknown>) => Promise<{ content: { text: string }[]; isError?: boolean }>;
function fakeServer() {
  const tools = new Map<string, { config: { inputSchema: Record<string, unknown> }; handler: Handler }>();
  return { tools, registerTool: (name: string, config: never, handler: Handler) => void tools.set(name, { config, handler }) };
}

test("tool: change_* の 6 つを足す。owner は引数でなく呼び出し元（自己申告させない）。error は isError", async () => {
  const t = setup();
  const s = fakeServer();
  registerChangeTools(s as never, { changes: t.mgr, owner: "pm1" });
  assert.deepEqual([...s.tools.keys()].sort(), ["change_list", "change_register", "change_reply", "change_status", "change_stop", "change_wait"]);
  for (const { config } of s.tools.values()) assert.equal("owner" in config.inputSchema, false);
  const r = await s.tools.get("change_register")!.handler({ change_id: "ch-1", scope: ["s1"], repo: "https://x/y.git" });
  assert.equal(r.isError, undefined);
  assert.equal((JSON.parse(r.content[0].text) as { notify_id: string }).notify_id, `${CAP}-pm1`);
  const l = await s.tools.get("change_list")!.handler({});
  assert.equal((JSON.parse(l.content[0].text) as unknown[]).length, 1);
  t.st.stopReply = { ...V, type: "error", ok: false, message: "止められない", command: "stop_change", change_id: "ch-1" };
  const e = await s.tools.get("change_stop")!.handler({ change_id: "ch-1" });
  assert.deepEqual([e.isError, (JSON.parse(e.content[0].text) as { error: string }).error], [true, "止められない"]);
});

test("tool: 入力の検証（scope が空・change_id が不正・repo が - で始まる）", async () => {
  const { z } = await import("zod");
  const { changeRegisterSchema } = await import("../src/change-tools.js");
  const schema = z.object(changeRegisterSchema);
  assert.equal(schema.safeParse({ change_id: "ch-1", scope: ["s"], repo: "https://x/y.git" }).success, true);
  assert.equal(schema.safeParse({ change_id: "ch-1", scope: [], repo: "https://x/y.git" }).success, false);
  assert.equal(schema.safeParse({ change_id: "a b", scope: ["s"], repo: "https://x/y.git" }).success, false);
  assert.equal(schema.safeParse({ change_id: "ch-1", scope: ["s"], repo: "--upload-pack=x" }).success, false);
});

test("createSessionMcpServer: changes を渡すと change_* が既存の remote_send / remote_list / worker_reply / task_status と並ぶ。渡さなければ足さない。実際に MCP で change_register を呼べる", async () => {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const { createSessionMcpServer } = await import("../src/server.js");
  const names = async (changes?: Parameters<typeof createSessionMcpServer>[0]["changes"]): Promise<{ names: string[]; client: InstanceType<typeof Client> }> => {
    const srv = createSessionMcpServer({ remotes: {} as never, owner: "pm1", ...(changes ? { changes } : {}) });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await srv.connect(a);
    const client = new Client({ name: "c", version: "0" });
    await client.connect(b);
    return { names: (await client.listTools()).tools.map((x) => x.name), client };
  };
  const t = setup();
  const withChanges = await names(t.mgr);
  for (const n of ["remote_send", "remote_list", "worker_reply", "task_status", "change_register", "change_list", "change_status", "change_wait", "change_stop", "change_reply"]) assert.ok(withChanges.names.includes(n), n);
  const r = await withChanges.client.callTool({ name: "change_register", arguments: { change_id: "ch-1", scope: ["s1"], repo: "https://x/y.git" } });
  assert.equal(r.isError, undefined);
  assert.equal(t.mgr.list({ owner: "pm1" }).length, 1);
  assert.deepEqual((await names()).names.filter((n) => n.startsWith("change_")), []);
});
