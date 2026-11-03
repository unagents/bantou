import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { createActivityStore, type ActivityStore } from "../src/activity.js";
import { z } from "zod";
import { createRemoteManager, remoteCreateSchema, type RemoteRecord } from "../src/remotes.js";
import type { ServerLink, ServerPeer } from "../src/server-link.js";
import { createJsonListStore } from "../src/store.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "center-rem-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
});

const peerA: ServerPeer = { id: "id-a", name: "bantou-server", version: "1.1.0" };
const peerB: ServerPeer = { id: "id-b", name: "other" };

function setup(over: Partial<ServerLink> = {}, activity?: ActivityStore, notify?: NonNullable<Parameters<typeof createRemoteManager>[0]["notify"]>) {
  const kicks: { peer: ServerPeer; cmd: Record<string, unknown>; resolve: (r: unknown) => void }[] = [];
  const stops: { peer: ServerPeer; cmd: unknown }[] = [];
  let peers = [peerA, peerB];
  const link = {
    peers: async () => peers,
    selectPeer: async (sel?: string) => {
      if (sel === undefined) return peers[0];
      const h = peers.find((p) => p.id === sel) ?? peers.find((p) => p.name === sel);
      if (!h) throw new Error(`server が見つからない: ${sel}`);
      return h;
    },
    kickCapOn: (peer: ServerPeer, cmd: Record<string, unknown>) =>
      new Promise((resolve) => kicks.push({ peer, cmd, resolve })),
    stopCapOn: async (peer: ServerPeer, cmd: unknown) => {
      stops.push({ peer, cmd });
      return { bantou: 1, type: "stop_result", ok: true, cap_id: (cmd as { cap_id: string }).cap_id, stopped: true };
    },
    ...over,
  } as unknown as ServerLink;
  const store = createJsonListStore<RemoteRecord>(join(dir, "remotes.json"), () => {});
  let n = 0;
  const mgr = createRemoteManager({ link, store, log: () => {}, newId: () => `r-${++n}`, ...(activity ? { activity } : {}), ...(notify ? { notify } : {}) });
  return { mgr, kicks, stops, store, setPeers: (p: ServerPeer[]) => (peers = p) };
}
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 10));

test("create: 返信を待たず running で返り、kick_cap を先頭 server に送る", async () => {
  const { mgr, kicks } = setup();
  const r = await mgr.create({ owner: "pm1", prompt: "go", repo: "https://x/y.git", branch: "main" });
  assert.deepEqual({ id: r.remote_id, server: r.server, state: r.state, owner: r.owner }, { id: "r-1", server: "id-a", state: "running", owner: "pm1" });
  assert.equal(kicks.length, 1);
  assert.equal(kicks[0].peer.id, "id-a");
  assert.deepEqual(kicks[0].cmd, { cap_id: "r-1", prompt: "go", repo: "https://x/y.git", branch: "main", reason: "remote_create owner=pm1" });
  const saved = JSON.parse(await readFile(join(dir, "remotes.json"), "utf8")) as RemoteRecord[];
  assert.equal(saved[0].state, "running");
});

test("create: model / worker_model は記録と kick_cap に載り、省略時は載らない", async () => {
  const { mgr, kicks } = setup();
  const r = await mgr.create({ owner: "pm1", prompt: "go", model: "sonnet", worker_model: "haiku" });
  assert.equal(r.model, "sonnet");
  assert.equal(r.worker_model, "haiku");
  assert.deepEqual(kicks[0].cmd, { cap_id: "r-1", prompt: "go", model: "sonnet", worker_model: "haiku", reason: "remote_create owner=pm1" });
  assert.equal(mgr.list()[0].model, "sonnet");
  const r2 = await mgr.create({ owner: "pm1", prompt: "go" });
  assert.ok(!("model" in r2) && !("worker_model" in r2));
  assert.ok(!("model" in kicks[1].cmd) && !("worker_model" in kicks[1].cmd));
});

test("remoteCreateSchema: model の形式を検証する", () => {
  const s = z.object(remoteCreateSchema);
  for (const m of ["sonnet", "opus", "haiku", "claude-sonnet-5-5", "opus[1m]", "a.b_c-d"]) assert.ok(s.safeParse({ prompt: "x", model: m, worker_model: m }).success, m);
  for (const m of ["", "-x", "--model", "a b", "a;b", "a\n", "a/b"]) {
    assert.ok(!s.safeParse({ prompt: "x", model: m }).success, `model ${JSON.stringify(m)}`);
    assert.ok(!s.safeParse({ prompt: "x", worker_model: m }).success, `worker_model ${JSON.stringify(m)}`);
  }
  assert.ok(s.safeParse({ prompt: "x" }).success);
});

test("create: server は peer id か名前で指定でき、見つからなければ記録を作らず失敗", async () => {
  const { mgr, kicks } = setup();
  assert.equal((await mgr.create({ owner: "o", prompt: "p", server: "id-b" })).serverName, "other");
  assert.equal((await mgr.create({ owner: "o", prompt: "p", server: "bantou-server" })).server, "id-a");
  await assert.rejects(mgr.create({ owner: "o", prompt: "p", server: "zzz" }), /見つからない/);
  assert.equal(mgr.list().length, 2);
  assert.equal(kicks.length, 2);
});

test("返信で state が done / failed に更新され、結果が残る", async () => {
  const { mgr, kicks } = setup();
  await mgr.create({ owner: "o", prompt: "p" });
  await mgr.create({ owner: "o", prompt: "p" });
  await mgr.create({ owner: "o", prompt: "p" });
  kicks[0].resolve({ bantou: 1, type: "cap_result", cap_id: "r-1", session_id: "s", ok: true, result_text: "OK!" });
  kicks[1].resolve({ bantou: 1, type: "error", ok: false, message: "boom", command: "kick_cap", cap_id: "r-2" });
  kicks[2].resolve({ bantou: 1, type: "cap_result", cap_id: "r-3", session_id: "s", ok: false, result_text: "", error: "timeout" });
  await tick();
  const by = Object.fromEntries(mgr.list().map((r) => [r.remote_id, r]));
  assert.equal(by["r-1"].state, "done");
  assert.equal(by["r-1"].result, "OK!");
  assert.ok(by["r-1"].finishedAt);
  assert.deepEqual([by["r-2"].state, by["r-2"].error], ["failed", "boom"]);
  assert.deepEqual([by["r-3"].state, by["r-3"].error], ["failed", "timeout"]);
});

test("送信自体の失敗（reject）も failed", async () => {
  const { mgr } = setup({ kickCapOn: async () => { throw new Error("link down"); } });
  await mgr.create({ owner: "o", prompt: "p" });
  await tick();
  assert.deepEqual([mgr.list()[0].state, mgr.list()[0].error], ["failed", "link down"]);
});

test("list: owner で絞れる。返り値の変更は内部に影響しない", async () => {
  const { mgr } = setup();
  await mgr.create({ owner: "a", prompt: "p" });
  await mgr.create({ owner: "b", prompt: "p" });
  assert.deepEqual(mgr.list({ owner: "a" }).map((r) => r.remote_id), ["r-1"]);
  assert.equal(mgr.list().length, 2);
  mgr.list()[0].state = "done";
  assert.equal(mgr.list()[0].state, "running");
});

test("delete: stop_cap を送って記録を外す。外した後の遅れた返信は記録を復活させない", async () => {
  const { mgr, kicks, stops } = setup();
  await mgr.create({ owner: "a", prompt: "p" });
  const r = await mgr.delete({ remote_id: "r-1", owner: "a" });
  assert.deepEqual(r, { remote_id: "r-1", deleted: true, stopped: true });
  assert.deepEqual(stops.map((s) => [s.peer.id, s.cmd]), [["id-a", { cap_id: "r-1" }]]);
  assert.equal(mgr.list().length, 0);
  kicks[0].resolve({ bantou: 1, type: "cap_result", cap_id: "r-1", session_id: "s", ok: false, result_text: "", error: "stop_cap により停止" });
  await tick();
  assert.equal(mgr.list().length, 0);
  assert.deepEqual(JSON.parse(await readFile(join(dir, "remotes.json"), "utf8")), []);
});

test("delete: 別 owner は拒否、未定義は拒否、owner 不明なら通る", async () => {
  const { mgr } = setup();
  await mgr.create({ owner: "a", prompt: "p" });
  await assert.rejects(mgr.delete({ remote_id: "r-1", owner: "b" }), /別の owner/);
  await assert.rejects(mgr.delete({ remote_id: "nope" }), /未定義/);
  assert.equal(mgr.list().length, 1);
  assert.equal((await mgr.delete({ remote_id: "r-1" })).deleted, true);
});

test("delete: server の peer id が変わっていても名前で探して stop を送る。居なければ running は拒否、force で記録だけ消す", async () => {
  const { mgr, stops, setPeers } = setup();
  await mgr.create({ owner: "a", prompt: "p" });
  await mgr.create({ owner: "a", prompt: "p" });
  setPeers([{ id: "id-new", name: "bantou-server" }]);
  await mgr.delete({ remote_id: "r-1" });
  assert.equal(stops[0].peer.id, "id-new");
  setPeers([]);
  await assert.rejects(mgr.delete({ remote_id: "r-2" }), /止められない/);
  assert.equal(mgr.list().length, 1);
  const f = await mgr.delete({ remote_id: "r-2", force: true });
  assert.deepEqual([f.deleted, f.stopped], [true, false]);
  assert.match(f.warning ?? "", /stop_cap を送れなかった/);
});

test("delete: stop が error 返信なら running は拒否。終わった記録は警告付きで消せる", async () => {
  const { mgr, kicks } = setup({
    stopCapOn: async () => ({ bantou: 1, type: "error", ok: false, message: "ng", command: "stop_cap" }),
  } as never);
  await mgr.create({ owner: "a", prompt: "p" });
  await assert.rejects(mgr.delete({ remote_id: "r-1" }), /ng/);
  kicks[0].resolve({ bantou: 1, type: "cap_result", cap_id: "r-1", session_id: "s", ok: true, result_text: "x" });
  await tick();
  const r = await mgr.delete({ remote_id: "r-1" });
  assert.equal(r.deleted, true);
  assert.match(r.warning ?? "", /ng/);
});

test("restore: 保存済みを読み、running は failed（返信を失った）にする", async () => {
  const { mgr, store } = setup();
  const base = { owner: "a", server: "id-a", serverName: "bantou-server", createdAt: "t" };
  await store.save([
    { ...base, remote_id: "r-9", state: "running" },
    { ...base, remote_id: "r-8", state: "done" },
    { ...base, remote_id: "bad id", state: "done" },
  ]);
  await mgr.restore();
  const by = Object.fromEntries(mgr.list().map((r) => [r.remote_id, r]));
  assert.deepEqual(Object.keys(by).sort(), ["r-8", "r-9"]);
  assert.equal(by["r-9"].state, "failed");
  assert.match(by["r-9"].error ?? "", /center 再起動/);
  assert.equal(by["r-8"].state, "done");
});

test("owner 形式が不正なら create は拒否", async () => {
  const { mgr } = setup();
  await assert.rejects(mgr.create({ owner: "a b", prompt: "p" }), /owner/);
});

test("list: activity 通知のある remote には activity が付き、無い remote には付かない。delete で忘れる", async () => {
  let now = 1_000_000;
  const activity = createActivityStore({ now: () => now });
  const { mgr } = setup({}, activity);
  await mgr.create({ owner: "a", prompt: "p" });
  await mgr.create({ owner: "a", prompt: "p" });
  activity.apply({
    bantou: 1, type: "activity", cap_id: "r-1", at: "2026-10-29T00:00:00.000Z",
    agents: [{ kind: "cap", id: "r-1", cap_id: "r-1", state: "running", task: "t", last_activity: null, last_output_at: null, silent_ms: 1000, started_at: null, finished_at: null }],
  });
  now += 2000;
  const [r1, r2] = mgr.list();
  assert.equal(r1!.activity?.agents[0]!.silent_ms, 3000);
  assert.equal(r1!.activity?.received_ms_ago, 2000);
  assert.equal("activity" in r2!, false);
  // 内部の記録には混ざらない（保存されない）
  assert.equal("activity" in (await mgr.list({ owner: "a" }))[1]!, false);
  await mgr.delete({ remote_id: "r-1", owner: "a" });
  assert.equal(activity.get("r-1"), undefined);
});

test("list: activity の store が無ければ activity キーは付かない", async () => {
  const { mgr } = setup();
  await mgr.create({ owner: "a", prompt: "p" });
  assert.equal("activity" in mgr.list()[0]!, false);
});

test("create: 門が断る（protocol の版違い・更新待ち）時は投げ、記録も kick_cap も作らない", async () => {
  const gated: Array<[string, string]> = [];
  const { mgr, kicks } = setup({
    gate: (p: ServerPeer, c: string) => {
      gated.push([p.id, c]);
      return { bantou: 1, type: "error", ok: false, message: "server 更新待ち（0.3.0→0.3.1）。再起動後に再送", code: "updating", retryable: true };
    },
  } as unknown as Partial<ServerLink>);
  await assert.rejects(mgr.create({ owner: "pm1", prompt: "go" }), /更新待ち.*再送/);
  assert.deepEqual(gated, [["id-a", "kick_cap"]]);
  assert.equal(kicks.length, 0);
  assert.deepEqual(mgr.list(), []);
});

test("create: 門が通せば従来どおり記録を作って kick_cap を送る", async () => {
  const { mgr, kicks } = setup({ gate: () => undefined } as unknown as Partial<ServerLink>);
  const r = await mgr.create({ owner: "pm1", prompt: "go" });
  assert.equal(r.state, "running");
  assert.equal(kicks.length, 1);
});

const lateOk = (id: string, text: string) => ({ bantou: 1, type: "cap_result", cap_id: id, session_id: "s", ok: true, result_text: text }) as const;
const workerAct = (capId: string, state: "running" | "stalled" | "done") => ({
  bantou: 1 as const, type: "activity" as const, cap_id: capId, at: "2026-11-03T00:00:00.000Z",
  agents: [
    { kind: "cap" as const, id: capId, cap_id: capId, state: "idle" as const, task: "t", last_activity: null, last_output_at: null, silent_ms: 0, started_at: null, finished_at: null },
    { kind: "worker" as const, id: "w-1", cap_id: capId, state, task: "t", last_activity: null, last_output_at: null, silent_ms: 0, started_at: null, finished_at: null },
  ],
});

test("applyLateReply: 最初の返信の後の cap_result で result が最新になり、失敗なら failed・次の成功で done に戻る", async () => {
  const { mgr, kicks } = setup();
  await mgr.create({ owner: "o", prompt: "p" });
  kicks[0].resolve(lateOk("r-1", "作業継続中。worker を起動した。report 待ち"));
  await tick();
  assert.equal(mgr.list()[0]!.result, "作業継続中。worker を起動した。report 待ち");
  assert.equal(mgr.applyLateReply(lateOk("r-1", "worker 完了。PR 作成済み")), true);
  let r = mgr.list()[0]!;
  assert.deepEqual({ state: r.state, result: r.result }, { state: "done", result: "worker 完了。PR 作成済み" });
  mgr.applyLateReply({ ...lateOk("r-1", "途中まで"), ok: false, error: "timeout" });
  r = mgr.list()[0]!;
  assert.deepEqual({ state: r.state, result: r.result, error: r.error }, { state: "failed", result: "途中まで", error: "timeout" });
  mgr.applyLateReply(lateOk("r-1", "復旧"));
  r = mgr.list()[0]!;
  assert.deepEqual({ state: r.state, result: r.result, error: r.error }, { state: "done", result: "復旧", error: undefined });
  await tick();
  const saved = JSON.parse(await readFile(join(dir, "remotes.json"), "utf8")) as RemoteRecord[];
  assert.equal(saved[0]!.result, "復旧");
  assert.equal("error" in saved[0]!, false);
});

test("applyLateReply: 再開の失敗（kick_cap の error）は failed + error。結果本文は残す", async () => {
  const { mgr, kicks } = setup();
  await mgr.create({ owner: "o", prompt: "p" });
  kicks[0].resolve(lateOk("r-1", "first"));
  await tick();
  mgr.applyLateReply({ bantou: 1, type: "error", ok: false, message: "resume 失敗", command: "kick_cap", cap_id: "r-1" });
  const r = mgr.list()[0]!;
  assert.deepEqual({ state: r.state, result: r.result, error: r.error }, { state: "failed", result: "first", error: "resume 失敗" });
});

test("applyLateReply: 記録なし・最初の返信待ち（running）・delete 済みは無視", async () => {
  const { mgr } = setup();
  assert.equal(mgr.applyLateReply(lateOk("r-x", "?")), false);
  await mgr.create({ owner: "o", prompt: "p" });
  assert.equal(mgr.applyLateReply(lateOk("r-1", "早すぎ")), false);
  assert.equal(mgr.list()[0]!.state, "running");
  assert.equal(mgr.list()[0]!.result, undefined);
});

test("list: cap が done でも配下の worker が running / stalled の間は running。全員終われば done", async () => {
  const activity = createActivityStore();
  const { mgr, kicks } = setup({}, activity);
  await mgr.create({ owner: "o", prompt: "p" });
  kicks[0].resolve(lateOk("r-1", "report 待ち"));
  await tick();
  activity.apply(workerAct("r-1", "running"));
  let r = mgr.list()[0]!;
  assert.deepEqual({ state: r.state, result: r.result, finished: r.finishedAt }, { state: "running", result: "report 待ち", finished: undefined });
  activity.apply(workerAct("r-1", "stalled"));
  assert.equal(mgr.list()[0]!.state, "running");
  activity.apply(workerAct("r-1", "done"));
  r = mgr.list()[0]!;
  assert.equal(r.state, "done");
  assert.ok(r.finishedAt);
});

test("list: failed は worker が動いていても failed のまま", async () => {
  const activity = createActivityStore();
  const { mgr, kicks } = setup({}, activity);
  await mgr.create({ owner: "o", prompt: "p" });
  kicks[0].resolve({ bantou: 1, type: "error", ok: false, message: "boom", command: "kick_cap", cap_id: "r-1" });
  await tick();
  activity.apply(workerAct("r-1", "running"));
  assert.equal(mgr.list()[0]!.state, "failed");
});

// -- 完了通知 / remote_wait --

function notifier(result: { ok: true } | { ok: false; reason: string } = { ok: true }) {
  const sent: { owner: string; text: string }[] = [];
  return { sent, notify: async (owner: string, text: string) => (sent.push({ owner, text }), result) };
}

test("通知: 最後の cap_result で owner へ 1 回。remote_id・state・result の先頭を含み、notifiedAt が付く", async () => {
  const n = notifier();
  const { mgr, kicks } = setup({}, undefined, n.notify);
  await mgr.create({ owner: "pm1", prompt: "p" });
  assert.equal(n.sent.length, 0);
  kicks[0].resolve(lateOk("r-1", "x".repeat(900)));
  await tick();
  assert.equal(n.sent.length, 1);
  assert.equal(n.sent[0].owner, "pm1");
  assert.match(n.sent[0].text, /remote_id=r-1 state=done/);
  assert.ok(n.sent[0].text.includes("x".repeat(500)) && !n.sent[0].text.includes("x".repeat(501)));
  const r = mgr.list()[0];
  assert.ok(r.notifiedAt);
  assert.equal(r.notifyError, undefined);
  assert.equal("notifiedKey" in r, false);
});

test("通知: failed（error 返信）も error 付きで送る", async () => {
  const n = notifier();
  const { mgr, kicks } = setup({}, undefined, n.notify);
  await mgr.create({ owner: "pm1", prompt: "p" });
  kicks[0].resolve({ bantou: 1, type: "error", ok: false, message: "boom", command: "kick_cap", cap_id: "r-1" });
  await tick();
  assert.equal(n.sent.length, 1);
  assert.match(n.sent[0].text, /state=failed/);
  assert.match(n.sent[0].text, /error: boom/);
});

test("通知: worker が running / stalled の間は送らず、全部終わった activity 通知で 1 回だけ送る", async () => {
  const n = notifier();
  const activity = createActivityStore();
  const { mgr, kicks } = setup({}, activity, n.notify);
  await mgr.create({ owner: "pm1", prompt: "p" });
  activity.apply(workerAct("r-1", "running"));
  kicks[0].resolve(lateOk("r-1", "worker 起動した"));
  await tick();
  assert.equal(n.sent.length, 0);
  assert.equal(mgr.list()[0].state, "running");
  activity.apply(workerAct("r-1", "stalled"));
  mgr.onActivity("r-1");
  await tick();
  assert.equal(n.sent.length, 0);
  activity.apply(workerAct("r-1", "done"));
  mgr.onActivity("r-1");
  mgr.onActivity("r-1");
  await tick();
  assert.equal(n.sent.length, 1);
  assert.match(n.sent[0].text, /worker 起動した/);
});

test("通知: 二重に送らない（同じ結果の再受信・activity 通知の繰り返し）。再開後の新しい結果では送り直す", async () => {
  const n = notifier();
  const activity = createActivityStore();
  const { mgr, kicks } = setup({}, activity, n.notify);
  await mgr.create({ owner: "pm1", prompt: "p" });
  kicks[0].resolve(lateOk("r-1", "first"));
  await tick();
  mgr.onActivity("r-1");
  mgr.applyLateReply(lateOk("r-1", "first"));
  await tick();
  assert.equal(n.sent.length, 1);
  // report で cap が再開されて再び終わる
  mgr.applyLateReply(lateOk("r-1", "second"));
  await tick();
  assert.equal(n.sent.length, 2);
  assert.match(n.sent[1].text, /second/);
  assert.equal(mgr.list()[0].notifiedAt !== undefined, true);
  // 再開の失敗も新しい結果として送る
  mgr.applyLateReply({ bantou: 1, type: "error", ok: false, message: "resume 失敗", command: "kick_cap", cap_id: "r-1" });
  await tick();
  assert.equal(n.sent.length, 3);
  assert.match(n.sent[2].text, /state=failed/);
});

test("通知: cap 自身が再開して running の間は送らない", async () => {
  const n = notifier();
  const activity = createActivityStore();
  const { mgr, kicks } = setup({}, activity, n.notify);
  await mgr.create({ owner: "pm1", prompt: "p" });
  kicks[0].resolve(lateOk("r-1", "first"));
  await tick();
  assert.equal(n.sent.length, 1);
  const capRunning = workerAct("r-1", "done");
  capRunning.agents[0].state = "running" as never;
  activity.apply(capRunning);
  mgr.applyLateReply(lateOk("r-1", "second"));
  await tick();
  assert.equal(n.sent.length, 1);
  assert.equal(mgr.list()[0].state, "running");
  activity.apply(workerAct("r-1", "done"));
  mgr.onActivity("r-1");
  await tick();
  assert.equal(n.sent.length, 2);
});

test("通知: 送れない時は notifyError を記録し、notifiedAt は付かない。再送もしない", async () => {
  const logs: string[] = [];
  const link = { selectPeer: async () => peerA } as unknown as ServerLink;
  // 通知が throw しても記録される
  const mgr2 = createRemoteManager({
    link: { ...link, kickCapOn: () => Promise.resolve(lateOk("r-2", "ok")) } as unknown as ServerLink,
    store: createJsonListStore<RemoteRecord>(join(dir, "remotes2.json"), () => {}),
    log: (m) => logs.push(m),
    newId: () => "r-2",
    notify: async () => {
      throw new Error("broker down");
    },
  });
  await mgr2.create({ owner: "pm1", prompt: "p" });
  await tick();
  const r = mgr2.list()[0];
  assert.equal(r.notifiedAt, undefined);
  assert.equal(r.notifyError, "broker down");
  assert.ok(logs.some((l) => l.includes("完了通知を送れない") && l.includes("broker down")));
  mgr2.onActivity("r-2");
  await tick();
  assert.equal(mgr2.list()[0].notifyError, "broker down");
});

test("通知: 失敗の理由が records に残り、送れた時は notifyError が消える", async () => {
  let ok = false;
  const { mgr, kicks } = setup({}, undefined, async () => (ok ? { ok: true } : { ok: false, reason: "peer なし" }));
  await mgr.create({ owner: "pm1", prompt: "p" });
  kicks[0].resolve(lateOk("r-1", "a"));
  await tick();
  assert.equal(mgr.list()[0].notifyError, "peer なし");
  ok = true;
  mgr.applyLateReply(lateOk("r-1", "b"));
  await tick();
  const r = mgr.list()[0];
  assert.ok(r.notifiedAt);
  assert.equal(r.notifyError, undefined);
});

test("通知: center 再起動前に終わっていた記録は、activity 通知が来ても通知しない。通知済みの記録は永続される", async () => {
  const n = notifier();
  const a = setup({}, undefined, n.notify);
  await a.mgr.create({ owner: "pm1", prompt: "p" });
  a.kicks[0].resolve(lateOk("r-1", "done!"));
  await tick();
  assert.equal(n.sent.length, 1);
  const saved = JSON.parse(await readFile(join(dir, "remotes.json"), "utf8")) as RemoteRecord[];
  assert.ok(saved[0].notifiedAt);
  const n2 = notifier();
  const link = { selectPeer: async () => peerA, kickCapOn: () => new Promise(() => {}) } as unknown as ServerLink;
  const mgr2 = createRemoteManager({ link, store: createJsonListStore<RemoteRecord>(join(dir, "remotes.json"), () => {}), log: () => {}, notify: n2.notify });
  await mgr2.restore();
  mgr2.onActivity("r-1");
  mgr2.applyLateReply(lateOk("r-1", "done!")); // 同じ結果
  await tick();
  assert.equal(n2.sent.length, 0);
  assert.equal(mgr2.list()[0].notifiedAt, saved[0].notifiedAt);
});

test("remote_wait: 終わるまで待って結果を返す。すでに終わっていれば即返す", async () => {
  const { mgr, kicks } = setup();
  await mgr.create({ owner: "pm1", prompt: "p" });
  const p = mgr.wait({ remote_id: "r-1", owner: "pm1", timeoutSec: 30 });
  await tick();
  kicks[0].resolve(lateOk("r-1", "finished"));
  const v = await p;
  assert.equal(v.state, "done");
  assert.equal(v.result, "finished");
  assert.equal((await mgr.wait({ remote_id: "r-1" })).state, "done");
});

test("remote_wait: worker が動いている間は待ち、全部終わった activity 通知で返る", async () => {
  const activity = createActivityStore();
  const { mgr, kicks } = setup({}, activity);
  await mgr.create({ owner: "pm1", prompt: "p" });
  activity.apply(workerAct("r-1", "running"));
  kicks[0].resolve(lateOk("r-1", "起動した"));
  await tick();
  let settled = false;
  const p = mgr.wait({ remote_id: "r-1", timeoutSec: 30 }).then((v) => ((settled = true), v));
  await tick();
  assert.equal(settled, false);
  activity.apply(workerAct("r-1", "done"));
  mgr.onActivity("r-1");
  assert.equal((await p).state, "done");
});

test("remote_wait: remote_id 省略は owner の running 中のどれか。running が無ければ error。別 owner は拒否", async () => {
  const { mgr, kicks } = setup();
  await assert.rejects(mgr.wait({ owner: "pm1" }), /running の remote が無い/);
  await assert.rejects(mgr.wait({}), /owner/);
  await mgr.create({ owner: "pm1", prompt: "p" });
  await mgr.create({ owner: "pm1", prompt: "p" });
  await mgr.create({ owner: "other", prompt: "p" });
  await assert.rejects(mgr.wait({ remote_id: "r-3", owner: "pm1" }), /別の owner/);
  await assert.rejects(mgr.wait({ remote_id: "zz" }), /未定義/);
  const p = mgr.wait({ owner: "pm1", timeoutSec: 30 });
  await tick();
  kicks[1].resolve(lateOk("r-2", "second first"));
  const v = await p;
  assert.equal(v.remote_id, "r-2");
  assert.equal(v.state, "done");
});

test("remote_wait: timeout なら state=running のまま返す。待ち中の delete は error", async () => {
  const { mgr } = setup();
  await mgr.create({ owner: "pm1", prompt: "p" });
  const t0 = Date.now();
  const v = await mgr.wait({ remote_id: "r-1", timeoutSec: 1 });
  assert.equal(v.state, "running");
  assert.ok(Date.now() - t0 >= 900);
  const p = mgr.wait({ remote_id: "r-1", timeoutSec: 30 });
  const rejected = assert.rejects(p, /削除された/);
  await tick();
  await mgr.delete({ remote_id: "r-1", force: true });
  await rejected;
});
