import assert from "node:assert/strict";
import { test } from "node:test";
import { createRemoteManager, type RemoteManager, type RemoteRecord } from "../src/remotes.js";
import type { LaunchInput, ReplyInput, ServerLink } from "../src/server-link.js";
import { createWorkerTracker } from "../src/worker-ws.js";

const WS = "ws://10.0.0.5:7910/ws/worker?token=tok";

function fakeLink() {
  const calls: Array<{ op: string; server: string; arg?: unknown }> = [];
  let fail: string | undefined;
  const link: ServerLink = {
    name: "bantou-center-0123456789",
    connect: async () => {},
    launch: async (server: string, i: LaunchInput) => {
      if (fail) throw new Error(fail);
      calls.push({ op: "launch", server, arg: i });
    },
    stop: async (server: string, parentId: string) => {
      if (fail) throw new Error(fail);
      calls.push({ op: "stop", server, arg: parentId });
    },
    reply: async (server: string, i: ReplyInput) => {
      if (fail) throw new Error(fail);
      calls.push({ op: "reply", server, arg: i });
    },
    requestServerInfo: async (server: string) => {
      calls.push({ op: "server-info", server });
    },
    serverVersionOf: () => undefined,
    notifyPeer: async () => ({ ok: false, reason: "n/a" }),
    peerMarkOf: async () => null,
    close: async () => {},
  };
  return { link, calls, failWith: (m: string | undefined) => (fail = m) };
}

function memStore(initial: RemoteRecord[] = []) {
  let saved: RemoteRecord[] = initial;
  return {
    store: { load: async () => structuredClone(saved), save: async (items: RemoteRecord[]) => void (saved = structuredClone(items)) },
    saved: () => saved,
  };
}

function setup(o: { initial?: RemoteRecord[]; servers?: Record<string, string[] | undefined>; ws?: string | undefined } = {}) {
  let t = 1_000_000;
  const clock = { now: () => t, advance: (ms: number) => void (t += ms) };
  const tracker = createWorkerTracker({ now: clock.now, silentMs: 60_000 });
  const fl = fakeLink();
  const mem = memStore(o.initial);
  const events: string[] = [];
  const memoryCalls: string[] = [];
  const manager: RemoteManager = createRemoteManager({
    link: fl.link,
    store: mem.store,
    log: () => {},
    tracker,
    wsUrl: () => ("ws" in o ? o.ws : WS),
    serversOf: (owner) => o.servers?.[owner],
    memoryEvents: { task: (s, x) => void memoryCalls.push(`task:${s}:${x.capId}:${x.goal}`), reply: (s, x) => void memoryCalls.push(`reply:${s}:${x.capId}:${x.workerId}:${x.text}`) },
    onSummaryChange: (s) => void events.push(s),
    now: clock.now,
    summaryCheckMs: 0,
  });
  return { manager, tracker, clock, ...fl, mem, events, memoryCalls };
}

test("send: parent-id = cap の名前（<session>-cap）、model 省略は既定、ws を載せる。返り値は送った事だけ。控えが 1 件でき running", async () => {
  const s = setup();
  await s.manager.restore();
  const r = await s.manager.send({ owner: "pm1", server: "bantou-server-aaaaaaaaaa", prompt: "do it" });
  assert.deepEqual(r, { remote_id: "pm1-cap@bantou-server-aaaaaaaaaa", server: "bantou-server-aaaaaaaaaa", sent: true });
  s.tracker.note("pm1-cap");
  const launch = s.calls.find((c) => c.op === "launch");
  assert.deepEqual(launch, { op: "launch", server: "bantou-server-aaaaaaaaaa", arg: { parentId: "pm1-cap", prompt: "do it", ws: WS } });
  assert.equal("model" in (launch as { arg: object }).arg, false, "model を省くと launch に model を入れない");
  const list = s.manager.list({ owner: "pm1" });
  assert.equal(list.length, 1);
  assert.equal(list[0]!.remote_id, "pm1-cap@bantou-server-aaaaaaaaaa");
  assert.equal(list[0]!.server, "bantou-server-aaaaaaaaaa");
  assert.equal(list[0]!.state, "running");
  assert.equal(list[0]!.finishedAt, undefined);
  assert.deepEqual(list[0]!.owners, ["pm1"]);
  assert.equal(s.mem.saved().length, 1);
  assert.ok(s.memoryCalls.some((c) => c === "task:pm1:pm1-cap:do it"));
  assert.deepEqual(s.manager.summary("pm1"), { running: 1, waitingReply: 0 });
});

test("send: 同じ session × server は 1 件のまま（model は最後の launch の値）。別 server は別の控え", async () => {
  const s = setup();
  await s.manager.send({ owner: "pm1", server: "srv-a", prompt: "one", model: "opus" });
  await s.manager.send({ owner: "pm1", server: "srv-a", prompt: "two", model: "sonnet" });
  await s.manager.send({ owner: "pm1", server: "srv-b", prompt: "three" });
  const list = s.manager.list({ owner: "pm1" });
  assert.deepEqual(list.map((v) => [v.server, v.model]), [["srv-a", "sonnet"], ["srv-b", undefined]]);
  assert.deepEqual(s.manager.list({ owner: "pm2" }), []);
  // remote_id は parent-id と server の名前の組で一意（parent-id は同じ）
  assert.deepEqual(list.map((v) => v.remote_id), ["pm1-cap@srv-a", "pm1-cap@srv-b"]);
  assert.deepEqual(s.calls.filter((c) => c.op === "launch").map((c) => (c.arg as LaunchInput).parentId), ["pm1-cap", "pm1-cap", "pm1-cap"]);
});

test("send: 不正な入力・ws の宛先が無い・送信失敗は投げ、控えを作らず launch も送らない（失敗時は控え無し）", async () => {
  const s = setup();
  await assert.rejects(() => s.manager.send({ owner: "pm 1", server: "srv", prompt: "x" }), /owner は英数字/);
  await assert.rejects(() => s.manager.send({ owner: "pm1", server: "", prompt: "x" }), /server が不正/);
  await assert.rejects(() => s.manager.send({ owner: "pm1", server: "srv", prompt: "" }), /prompt が不正/);
  await assert.rejects(() => s.manager.send({ owner: "pm1", server: "srv", prompt: "a\0b" }), /prompt が不正/);
  await assert.rejects(() => s.manager.send({ owner: "pm1", server: "srv", prompt: "x", model: "-bad" }), /model が不正/);
  assert.equal(s.calls.length, 0);
  s.failWith("send failed");
  await assert.rejects(() => s.manager.send({ owner: "pm1", server: "srv", prompt: "x" }), /send failed/);
  assert.deepEqual(s.manager.list(), []);

  const noWs = setup({ ws: undefined });
  await assert.rejects(() => noWs.manager.send({ owner: "pm1", server: "srv", prompt: "x" }), /ws の宛先が決まらない.*publicHost/);
  assert.equal(noWs.calls.length, 0);
});

test("state: ws の最後の書き込みから 60 秒以内は running、無音なら done + finishedAt（最後の書き込みの時刻）。書き込みで running に戻る", async () => {
  const s = setup();
  await s.manager.send({ owner: "pm1", server: "srv", prompt: "x" });
  s.tracker.note("pm1-cap");
  s.clock.advance(59_000);
  assert.equal(s.manager.list()[0]!.state, "running");
  s.clock.advance(1_000);
  const stopped = s.manager.list()[0]!;
  assert.equal(stopped.state, "stopped");
  assert.equal(stopped.finishedAt, new Date(1_000_000).toISOString());
  assert.deepEqual(s.manager.summary("pm1"), { running: 0, waitingReply: 0 });
  s.tracker.note("pm1-cap");
  assert.equal(s.manager.list()[0]!.state, "running");
  assert.equal(s.manager.list()[0]!.finishedAt, undefined);
});

test("summary の変化は onSummaryChange で知らせる（running の件数が変わった時だけ）", async () => {
  const s = setup();
  await s.manager.send({ owner: "pm1", server: "srv", prompt: "x" });
  s.tracker.note("pm1-cap");
  assert.deepEqual(s.events, ["pm1"]);
  s.tracker.note("pm1-cap");
  assert.deepEqual(s.events, ["pm1"]);
  s.clock.advance(61_000);
  s.tracker.note("other-cap"); // 変化の確認の契機（周期の確認と同じ経路）
  assert.deepEqual(s.events, ["pm1", "pm1"]);
});

test("stop: stop を送り、その cap の控えと ws の記録を消す。控えが無くても stop は送る", async () => {
  const s = setup();
  await s.manager.send({ owner: "pm1", server: "srv", prompt: "x" });
  const r = await s.manager.stop({ owner: "pm1", server: "srv" });
  assert.deepEqual(r, { remote_id: "pm1-cap@srv", server: "srv", sent: true, forgotten: true });
  assert.deepEqual(s.calls.filter((c) => c.op === "stop"), [{ op: "stop", server: "srv", arg: "pm1-cap" }]);
  assert.deepEqual(s.manager.list(), []);
  assert.equal(s.tracker.lastAt("pm1-cap"), undefined);
  assert.deepEqual(s.mem.saved(), []);
  const again = await s.manager.stop({ owner: "pm1", server: "srv" });
  assert.equal(again.forgotten, false);
  assert.equal(s.calls.filter((c) => c.op === "stop").length, 2);
});

test("stop: 同じ cap の名前で他の server の控えが残る間は、ws の記録を消さない。送信失敗は投げ、控えは残る", async () => {
  const s = setup();
  await s.manager.send({ owner: "pm1", server: "srv-a", prompt: "x" });
  await s.manager.send({ owner: "pm1", server: "srv-b", prompt: "y" });
  s.tracker.note("pm1-cap");
  await s.manager.stop({ owner: "pm1", server: "srv-a" });
  assert.notEqual(s.tracker.lastAt("pm1-cap"), undefined);
  s.failWith("send failed");
  await assert.rejects(() => s.manager.stop({ owner: "pm1", server: "srv-b" }), /send failed/);
  assert.equal(s.manager.list().length, 1);
});

test("reply: answer / approve / reject を送る。owner 無し（desktop の center_call）は範囲を見ない。不正な入力は投げる", async () => {
  const s = setup({ servers: { pm1: ["srv-a"] } });
  assert.deepEqual(await s.manager.reply({ owner: "pm1", server: "srv-a", session_id: "w-1", order: "answer", content: "yes" }), { server: "srv-a", session_id: "w-1", order: "answer", sent: true });
  await s.manager.reply({ owner: "pm1", server: "srv-a", session_id: "w-1", order: "approve" });
  await s.manager.reply({ server: "srv-zzz", session_id: "w-2", order: "reject" });
  assert.deepEqual(s.calls.filter((c) => c.op === "reply").map((c) => c.arg), [
    { sessionId: "w-1", order: "answer", content: "yes" },
    { sessionId: "w-1", order: "approve" },
    { sessionId: "w-2", order: "reject" },
  ]);
  assert.deepEqual(s.memoryCalls, ["reply:pm1:pm1-cap@srv-a:w-1:yes", "reply:pm1:pm1-cap@srv-a:w-1:approve"]);
  await assert.rejects(() => s.manager.reply({ owner: "pm1", server: "srv-zzz", session_id: "w-1", order: "approve" }), /この session の servers に無い/);
  await assert.rejects(() => s.manager.reply({ owner: "pm1", server: "srv-a", session_id: "", order: "approve" }), /session_id が不正/);
  await assert.rejects(() => s.manager.reply({ owner: "pm1", server: "srv-a", session_id: "w", order: "answer", content: "a\0" }), /content が不正/);
  assert.equal(s.calls.filter((c) => c.op === "reply").length, 3);
});

test("servers の範囲: 範囲外の server への send は error で何も送らず控えも作らない。空配列は何も使わない。大文字小文字は区別しない", async () => {
  const s = setup({ servers: { pm1: ["Srv-A"], pm2: [] } });
  await s.manager.send({ owner: "pm1", server: "srv-a", prompt: "ok" });
  await assert.rejects(() => s.manager.send({ owner: "pm1", server: "srv-b", prompt: "x" }), /この session の servers に無い: srv-b/);
  await assert.rejects(() => s.manager.send({ owner: "pm2", server: "srv-a", prompt: "x" }), /空 = どの server も使わない/);
  assert.equal(s.calls.filter((c) => c.op === "launch").length, 1);
  assert.deepEqual(s.manager.list().map((v) => v.server), ["srv-a"]);
});

test("list / scopeOf: 範囲を狭めた後の範囲外の自分の cap は既定で出ない。includeOutOfScope で出る。他の session の cap は出ない", async () => {
  const servers: Record<string, string[] | undefined> = {};
  const s = setup({ servers });
  await s.manager.send({ owner: "pm1", server: "srv-a", prompt: "x" });
  await s.manager.send({ owner: "pm1", server: "srv-b", prompt: "y" });
  await s.manager.send({ owner: "pm2", server: "srv-b", prompt: "z" });
  servers.pm1 = ["srv-a"];
  assert.deepEqual(s.manager.list({ owner: "pm1" }).map((v) => v.server), ["srv-a"]);
  assert.deepEqual(s.manager.list({ owner: "pm1", includeOutOfScope: true }).map((v) => v.server), ["srv-a", "srv-b"]);
  assert.deepEqual(s.manager.scopeOf("pm1"), { servers: ["srv-a"], out_of_scope: 1 });
  assert.deepEqual(s.manager.scopeOf("pm2"), { servers: undefined, out_of_scope: 0 });
  assert.equal(s.manager.list().length, 3);
  // 範囲外の自分の cap は stop で片付けられる
  const r = await s.manager.stop({ owner: "pm1", server: "srv-b" });
  assert.equal(r.forgotten, true);
});

test("wait: 止まっている cap があれば即返す。動いている間は無音 60 秒で返る（書き込みで延びる）。timeout は running のまま返す", async () => {
  const s = setup();
  await s.manager.send({ owner: "pm1", server: "srv", prompt: "x" });
  s.tracker.note("pm1-cap");
  // 実時間の待ちを短くするため、tracker / manager の時計は進めて待ちを起こす
  const waiting = s.manager.wait({ owner: "pm1", timeoutSec: 600 });
  let settled = false;
  void waiting.then(() => void (settled = true));
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(settled, false);
  s.clock.advance(30_000);
  s.tracker.note("pm1-cap"); // 書き込み: 無音の起点が延びる
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(settled, false);
  s.clock.advance(60_000);
  s.tracker.note("other-cap"); // 起こす
  const v = await waiting;
  assert.equal(v.state, "stopped");
  assert.equal(v.remote_id, "pm1-cap@srv");

  // すでに止まっていれば即返す
  const again = await s.manager.wait({ remote_id: "pm1-cap@srv" });
  assert.equal(again.state, "stopped");

  // 動いている cap は timeout で running のまま返す
  const t = setup();
  await t.manager.send({ owner: "pm1", server: "srv", prompt: "x" });
  t.tracker.note("pm1-cap");
  const timeoutRun = t.manager.wait({ owner: "pm1", timeoutSec: 1 });
  t.clock.advance(1_000);
  t.tracker.note("pm1-cap");
  const r = await timeoutRun;
  assert.equal(r.state, "running");
});

test("wait: 対象が無い・owner 無しで remote_id 省略・待っている間に stop された場合は投げる", async () => {
  const s = setup();
  await assert.rejects(() => s.manager.wait({ owner: "pm1" }), /待つ remote が無い/);
  await assert.rejects(() => s.manager.wait({}), /owner/);
  await s.manager.send({ owner: "pm1", server: "srv", prompt: "x" });
  s.tracker.note("pm1-cap");
  const waiting = s.manager.wait({ owner: "pm1", timeoutSec: 600 });
  const rejected = assert.rejects(() => waiting, /止められた/);
  await new Promise((r) => setTimeout(r, 20));
  await s.manager.stop({ owner: "pm1", server: "srv" });
  await rejected;
});

test("conflictsWith: cap の名前が別の session の控えと同じになる create / rename は拒否。改名元の控えは衝突と見なさない", async () => {
  const s = setup();
  await s.manager.send({ owner: "pm1", server: "srv", prompt: "x" });
  // create: "pm1-cap" の cap の名前は session pm1 が持つ（"pm1" と "pm1-cap" は同じ cap の名前になる）
  assert.match(s.manager.conflictsWith("pm1-cap", "create") ?? "", /別の session（pm1）/);
  assert.equal(s.manager.conflictsWith("pm1", "create"), null);
  assert.equal(s.manager.conflictsWith("pm3", "create"), null);
  // rename: pm1 → pm2 は可。pm9 → pm1 は不可（pm1 の控えが残っている）。pm1 → pm1-cap は改名元なので可
  assert.equal(s.manager.conflictsWith("pm2", "rename", "pm1"), null);
  assert.match(s.manager.conflictsWith("pm1", "rename", "pm9") ?? "", /remote の控えが残っている/);
  assert.equal(s.manager.conflictsWith("pm1-cap", "rename", "pm1"), null);
});

test("renameSession: session と cap の名前（remote_id）を付け替える。件数を返し、0 件なら保存しない", async () => {
  const s = setup();
  await s.manager.send({ owner: "pm1", server: "srv-a", prompt: "x" });
  await s.manager.send({ owner: "pm1", server: "srv-b", prompt: "y" });
  assert.equal(await s.manager.renameSession("pm1", "pm2"), 2);
  assert.deepEqual(s.manager.list({ owner: "pm2" }).map((v) => [v.session, v.remote_id]), [["pm2", "pm2-cap@srv-a"], ["pm2", "pm2-cap@srv-b"]]);
  assert.deepEqual(s.manager.list({ owner: "pm1" }), []);
  assert.deepEqual(s.mem.saved().map((r) => r.session), ["pm2", "pm2"]);
  assert.equal(await s.manager.renameSession("nobody", "x"), 0);
});

test("restore: 今の規約の控えは復元し、旧 1.x の形式（cap_id が c-…、session の無い共有 cap など）は捨てて保存し直す。旧い欄は引き継がない", async () => {
  const old = [
    { remote_id: "c-0a1b2c3d4e-pm1", session: "pm1", server: "srv-id", serverName: "bantou-server", state: "done", createdAt: "2026-11-01T00:00:00.000Z", pending: [] },
    { remote_id: "c-0a1b2c3d4e", server: "srv-id", serverName: "bantou-server", state: "done", createdAt: "2026-11-01T00:00:00.000Z", pending: [] },
    { remote_id: "pm2-cap@srv-x", session: "pm2", server: "srv-x", serverName: "ignored", model: "opus", state: "running", createdAt: "2026-11-02T00:00:00.000Z", pending: [{}], worker_reports: [{}] },
    { remote_id: "bad", session: "pm 3", server: "srv" },
  ] as unknown as RemoteRecord[];
  const s = setup({ initial: old });
  await s.manager.restore();
  const list = s.manager.list();
  assert.equal(list.length, 1);
  assert.deepEqual({ ...list[0]! }, {
    remote_id: "pm2-cap@srv-x",
    session: "pm2",
    server: "srv-x",
    serverName: "srv-x",
    model: "opus",
    createdAt: "2026-11-02T00:00:00.000Z",
    state: "stopped",
    owners: ["pm2"],
    server_label: "srv-x",
  } as unknown as (typeof list)[number]);
  // 保存し直されている（旧い欄は残らない）
  assert.deepEqual(s.mem.saved(), [{ remote_id: "pm2-cap@srv-x", session: "pm2", server: "srv-x", serverName: "srv-x", model: "opus", createdAt: "2026-11-02T00:00:00.000Z" }]);
});
