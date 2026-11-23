import assert from "node:assert/strict";
import { test } from "node:test";
import type { ChangeProgressNotice, WorkerReportNotice } from "@agent-hand/bantou-protocol";
import { createChangeManager, type ChangeRecord } from "../src/changes.js";
import { registerChangeTools } from "../src/change-tools.js";
import type { ServerLink, ServerPeer } from "../src/server-link.js";

const CAP = "c-0123456789";
const peerA: ServerPeer = { id: "id-a", name: "bantou-server", hostname: "host-a", version: "1.9.0", server_id: "srv-a" };
const peerB: ServerPeer = { id: "id-b", name: "bantou-server", hostname: "host-b", version: "1.9.0", server_id: "srv-b" };
const V = { bantou: 1 };

function setup(opts: { serversOf?: (o: string) => string[] | undefined; peers?: ServerPeer[] } = {}) {
  const calls: Array<{ fn: string; peer: string; cmd?: unknown }> = [];
  const st = {
    registerReply: undefined as unknown,
    stopReply: undefined as unknown,
    replyReply: undefined as unknown,
    blocked: undefined as unknown,
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
    gate: () => st.blocked,
    registerChangeOn: async (p: ServerPeer, cmd: { change_id: string }) => {
      calls.push({ fn: "register", peer: p.id, cmd });
      return st.registerReply ?? { ...V, type: "register_change_result", ok: true, change_id: cmd.change_id, accepted: true, state: "in_progress" };
    },
    workerStopOn: async (p: ServerPeer, cmd: { change_id: string; worker_id: string }) => {
      calls.push({ fn: "worker_stop", peer: p.id, cmd });
      return st.stopReply ?? { ...V, type: "worker_stop_result", ok: true, change_id: cmd.change_id, worker_id: cmd.worker_id, stopped: true };
    },
    workerReplyOn: async (p: ServerPeer, cmd: { change_id: string; worker_id: string }) => {
      calls.push({ fn: "worker_reply", peer: p.id, cmd });
      return st.replyReply ?? { ...V, type: "worker_reply_result", ok: true, change_id: cmd.change_id, worker_id: cmd.worker_id, accepted: true };
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
const report = (over: Partial<WorkerReportNotice> = {}): WorkerReportNotice => ({
  ...V, type: "worker_report", change_id: "ch-1", worker_id: "w-1", kind: "ask", text: "どうする？", at: "2026-11-23T00:00:00Z", ...over,
}) as WorkerReportNotice;
const progress = (over: Partial<ChangeProgressNotice> = {}): ChangeProgressNotice => ({
  ...V, type: "change_progress", notify_id: `${CAP}-pm1`, change_id: "ch-1", step: 1, change_state: "completed", step_state: "passed", at: "2026-11-23T00:01:00Z", ...over,
}) as ChangeProgressNotice;

test("register: notify_id（<center の cap_id>-<session>）を付けて server へ送り、記録を保存する。server は選んだ peer", async () => {
  const t = setup();
  const r = await t.mgr.register({ ...reg(), branch: "b1", worker_model: "sonnet" });
  assert.deepEqual([r.change_id, r.server, r.state, r.accepted, r.notify_id], ["ch-1", "srv-a", "in_progress", true, `${CAP}-pm1`]);
  assert.deepEqual(t.calls[0].cmd, { change_id: "ch-1", scope: ["s1", "s2"], repo: "https://x/y.git", branch: "b1", worker_model: "sonnet", notify_id: `${CAP}-pm1` });
  assert.equal(t.saved().length, 1);
  assert.equal(t.saved()[0].session, "pm1");
  // 記録は server を引くための物だけ（質問・進みの写しは持たない）
  assert.deepEqual(Object.keys(t.saved()[0]).sort(), ["branch", "change_id", "notify_id", "peer", "registered_at", "repo", "scope", "serverHost", "serverName", "server_id", "session", "worker_model"].sort());
});

test("register: server の error は投げる（記録は作らない）", async () => {
  const t = setup();
  t.st.registerReply = { ...V, type: "error", ok: false, message: "change は in_progress の間は再登録できない" };
  await assert.rejects(t.mgr.register(reg()), /再登録できない/);
  assert.equal(t.saved().length, 0);
});

test("register: 再登録は前の登録の server へ送り、同じ change_id の記録を置き換える", async () => {
  const t = setup({ peers: [peerA, peerB] });
  await t.mgr.register({ ...reg(), server: "srv-b" });
  await t.mgr.register(reg());
  assert.equal(t.calls[1].peer, "id-b");
  assert.equal(t.saved().length, 1);
});

test("register: session の servers の範囲外の server は断る。範囲内だけが既定の候補", async () => {
  const t = setup({ peers: [peerA, peerB], serversOf: () => ["host-b"] });
  await assert.rejects(t.mgr.register({ ...reg(), server: "srv-a" }), /servers に無い/);
  const r = await t.mgr.register(reg());
  assert.equal(r.server, "srv-b");
});

test("worker_report（change_id つき）: owner へ push する。返答の道具は今の worker_reply（change_id を渡す）", async () => {
  const t = setup();
  await t.mgr.register(reg());
  t.mgr.onWorkerReport(report({ text: "q1" }), "id-a");
  assert.equal(t.notified.length, 1);
  assert.equal(t.notified[0].owner, "pm1");
  assert.match(t.notified[0].text, /worker_report change_id=ch-1 worker=w-1 kind=ask/);
  assert.match(t.notified[0].text, /q1/);
  assert.match(t.notified[0].text, /worker_reply\(change_id="ch-1", worker_id="w-1", text\)/);
});

test("worker_report: 記録の無い change_id・change_id の無い report は捨てる（push しない）", async () => {
  const t = setup();
  await t.mgr.register(reg());
  t.mgr.onWorkerReport(report({ change_id: "ch-zzz" }));
  t.mgr.onWorkerReport({ ...report(), change_id: undefined, cap_id: "c1" });
  assert.equal(t.notified.length, 0);
});

test("worker_report / change_progress: 登録した server と別の server から届いた同じ change_id の通知は取り違えず捨てる", async () => {
  const t = setup({ peers: [peerA, peerB] });
  await t.mgr.register({ ...reg(), server: "srv-a" });
  t.mgr.onWorkerReport(report(), "id-b");
  t.mgr.onChangeProgress(progress(), "id-b");
  assert.equal(t.notified.length, 0);
  t.mgr.onWorkerReport(report(), "id-a");
  assert.equal(t.notified.length, 1);
});

test("change_progress: owner へ push する（止められた・範囲を終えた）", async () => {
  const t = setup();
  await t.mgr.register(reg());
  t.mgr.onChangeProgress(progress({ change_state: "stopped", step_state: "stopped", reason: "worker が止められた" }), "id-a");
  assert.equal(t.notified.length, 1);
  assert.match(t.notified[0].text, /change_progress change_id=ch-1 step=1 change=stopped step_state=stopped reason=worker が止められた/);
  t.mgr.onChangeProgress(progress({ change_id: "ch-zzz" }), "id-a");
  assert.equal(t.notified.length, 1);
});

test("workerReply: 今の worker_reply を change_id で server へ送る（cap_id は付けない）。server の error は投げる", async () => {
  const t = setup();
  await t.mgr.register(reg());
  t.st.replyReply = { ...V, type: "error", ok: false, message: "worker が返答待ちでない", command: "worker_reply", change_id: "ch-1" };
  await assert.rejects(t.mgr.workerReply({ owner: "pm1", change_id: "ch-1", worker_id: "w-1", text: "こう" }), /返答待ちでない/);
  t.st.replyReply = undefined;
  const r = await t.mgr.workerReply({ owner: "pm1", change_id: "ch-1", worker_id: "w-1", text: "こう" });
  assert.deepEqual(r, { change_id: "ch-1", server: "srv-a", worker_id: "w-1", accepted: true });
  assert.deepEqual(t.calls.at(-1)?.cmd, { change_id: "ch-1", worker_id: "w-1", text: "こう" });
  await assert.rejects(t.mgr.workerReply({ owner: "pm1", change_id: "ch-1", worker_id: "w-1", text: "a\0b" }), /不正/);
  await assert.rejects(t.mgr.workerReply({ owner: "pm2", change_id: "ch-1", worker_id: "w-1", text: "x" }), /未定義の change/);
  t.st.blocked = { ...V, type: "error", ok: false, message: "protocol の版が合わない" };
  await assert.rejects(t.mgr.workerReply({ owner: "pm1", change_id: "ch-1", worker_id: "w-1", text: "x" }), /版が合わない/);
});

test("workerStop: 今の worker_stop を change_id で server へ送る。他の session の change の worker は止められない", async () => {
  const t = setup();
  await t.mgr.register(reg("pm1", "ch-1"));
  assert.deepEqual(await t.mgr.workerStop({ owner: "pm1", change_id: "ch-1", worker_id: "w-1" }), { change_id: "ch-1", server: "srv-a", worker_id: "w-1", stopped: true });
  assert.deepEqual(t.calls.at(-1)?.cmd, { change_id: "ch-1", worker_id: "w-1" });
  await assert.rejects(t.mgr.workerStop({ owner: "pm2", change_id: "ch-1", worker_id: "w-1" }), /未定義の change/);
  await assert.rejects(t.mgr.workerStop({ owner: "pm1", change_id: "ch-1", worker_id: "a b" }), /worker_id/);
  t.st.stopReply = { ...V, type: "error", ok: false, message: "worker を止められなかった w-1", command: "worker_stop", change_id: "ch-1" };
  await assert.rejects(t.mgr.workerStop({ owner: "pm1", change_id: "ch-1", worker_id: "w-1" }), /止められなかった/);
  t.st.stopReply = undefined;
  t.st.blocked = { ...V, type: "error", ok: false, message: "protocol の版が合わない" };
  await assert.rejects(t.mgr.workerStop({ owner: "pm1", change_id: "ch-1", worker_id: "w-1" }), /版が合わない/);
});

test("restore: 保存した記録を読み戻し、通知を引き当てられる", async () => {
  const t = setup();
  await t.mgr.register(reg());
  const t2 = setup();
  await t2.store.save(t.saved());
  await t2.mgr.restore();
  t2.mgr.onWorkerReport(report(), "id-a");
  assert.equal(t2.notified.length, 1);
});

// -- tool --
type Handler = (args: Record<string, unknown>) => Promise<{ content: { text: string }[]; isError?: boolean }>;
function fakeServer() {
  const tools = new Map<string, { config: { inputSchema: Record<string, unknown> }; handler: Handler }>();
  return { tools, registerTool: (name: string, config: never, handler: Handler) => void tools.set(name, { config, handler }) };
}

test("tool: change_register だけを足す（一覧・進み・待ち・止める・返答の tool は無い）。owner は引数でなく呼び出し元。error は isError", async () => {
  const t = setup();
  const s = fakeServer();
  registerChangeTools(s as never, { changes: t.mgr, owner: "pm1" });
  assert.deepEqual([...s.tools.keys()], ["change_register"]);
  assert.equal("owner" in s.tools.get("change_register")!.config.inputSchema, false);
  const r = await s.tools.get("change_register")!.handler({ change_id: "ch-1", scope: ["s1"], repo: "https://x/y.git" });
  assert.equal(r.isError, undefined);
  assert.equal((JSON.parse(r.content[0].text) as { notify_id: string }).notify_id, `${CAP}-pm1`);
  t.st.registerReply = { ...V, type: "error", ok: false, message: "進行中", command: "register_change", change_id: "ch-1" };
  const e = await s.tools.get("change_register")!.handler({ change_id: "ch-1", scope: ["s1"], repo: "https://x/y.git" });
  assert.deepEqual([e.isError, (JSON.parse(e.content[0].text) as { error: string }).error], [true, "進行中"]);
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

test("createSessionMcpServer: 新しい tool 名は change_register だけ。worker_reply / worker_stop は change_id でも通り、cap の worker は今の道具のまま", async () => {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const { createSessionMcpServer } = await import("../src/server.js");
  const capCalls: Array<{ fn: string; input: unknown }> = [];
  const remotes = {
    workerReply: async (input: unknown) => (capCalls.push({ fn: "reply", input }), { remote_id: "r1", server: "s", worker_id: "w-9", accepted: true }),
    workerStop: async (input: unknown) => (capCalls.push({ fn: "stop", input }), { remote_id: "r1", server: "s", worker_id: "w-9", stopped: true }),
  };
  const connect = async (changes?: Parameters<typeof createSessionMcpServer>[0]["changes"]) => {
    const srv = createSessionMcpServer({ remotes: remotes as never, owner: "pm1", ...(changes ? { changes } : {}) });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await srv.connect(a);
    const client = new Client({ name: "c", version: "0" });
    await client.connect(b);
    return client;
  };
  const text = (r: unknown): string => ((r as { content: { text: string }[] }).content[0]?.text) ?? "";
  const t = setup();
  const withChanges = await connect(t.mgr);
  const names = (await withChanges.listTools()).tools.map((x) => x.name);
  for (const n of ["remote_send", "remote_list", "worker_reply", "worker_stop", "task_status", "change_register"]) assert.ok(names.includes(n), n);
  for (const n of ["change_list", "change_status", "change_wait", "change_stop", "change_reply"]) assert.equal(names.includes(n), false, n);
  const r = await withChanges.callTool({ name: "change_register", arguments: { change_id: "ch-1", scope: ["s1"], repo: "https://x/y.git" } });
  assert.equal(r.isError, undefined);
  // change の worker: change_id で通る
  const rep = await withChanges.callTool({ name: "worker_reply", arguments: { change_id: "ch-1", worker_id: "w-1", text: "こう" } });
  assert.equal(rep.isError, undefined);
  assert.deepEqual(JSON.parse(text(rep)), { change_id: "ch-1", server: "srv-a", worker_id: "w-1", accepted: true });
  const stp = await withChanges.callTool({ name: "worker_stop", arguments: { change_id: "ch-1", worker_id: "w-1" } });
  assert.deepEqual(JSON.parse(text(stp)), { change_id: "ch-1", server: "srv-a", worker_id: "w-1", stopped: true });
  assert.deepEqual(capCalls, []);
  // cap の worker: 今の経路（remotes）。owner は呼び出し元
  await withChanges.callTool({ name: "worker_reply", arguments: { worker_id: "w-9", text: "x" } });
  await withChanges.callTool({ name: "worker_stop", arguments: { worker_id: "w-9", task_id: "t-1" } });
  assert.deepEqual(capCalls, [
    { fn: "reply", input: { worker_id: "w-9", text: "x", owner: "pm1" } },
    { fn: "stop", input: { worker_id: "w-9", owner: "pm1", task_id: "t-1" } },
  ]);
  // 混ぜない
  for (const args of [{ change_id: "ch-1", remote_id: "r1", worker_id: "w-1", text: "x" }, { change_id: "ch-1", server: "s", worker_id: "w-1", text: "x" }]) {
    assert.equal((await withChanges.callTool({ name: "worker_reply", arguments: args })).isError, true);
  }
  assert.equal((await withChanges.callTool({ name: "worker_stop", arguments: { change_id: "ch-1", task_id: "t-1", worker_id: "w-1" } })).isError, true);
  // changes を渡さなければ change_register は無く、change_id も通らない
  const without = await connect();
  assert.deepEqual((await without.listTools()).tools.map((x) => x.name).filter((n) => n.startsWith("change_")), []);
  assert.equal((await without.callTool({ name: "worker_reply", arguments: { change_id: "ch-1", worker_id: "w-1", text: "x" } })).isError, true);
});
