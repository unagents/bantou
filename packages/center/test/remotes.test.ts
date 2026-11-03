import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { createActivityStore, type ActivityStore } from "../src/activity.js";
import { z } from "zod";
import { parseConfig } from "../src/config.js";
import { loadCapId } from "../src/center-id.js";
import { createRemoteManager, remoteCreateSchema, remoteSendSchema, type RemoteManager, type RemoteRecord } from "../src/remotes.js";
import type { ServerLink, ServerPeer } from "../src/server-link.js";
import { createJsonListStore } from "../src/store.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "center-rem-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
});

const CAP = "c-0123456789";
const peerA: ServerPeer = { id: "id-a", name: "bantou-server", hostname: "host-a", version: "1.1.0" };
const peerB: ServerPeer = { id: "id-b", name: "other", hostname: "host-b" };

type Notify = NonNullable<Parameters<typeof createRemoteManager>[0]["notify"]>;

function setup(over: Partial<ServerLink> = {}, activity?: ActivityStore, notify?: Notify, servers?: ReturnType<typeof parseConfig>["servers"], extra: Partial<Parameters<typeof createRemoteManager>[0]> = {}) {
  const kicks: { peer: ServerPeer; cmd: Record<string, unknown>; resolve: (r: unknown) => void }[] = [];
  const stops: { peer: ServerPeer; cmd: unknown }[] = [];
  /** server ごとの cap の有無（status_result.caps）。 */
  const caps = new Map<string, string[]>();
  let peers = [peerA, peerB];
  const link = {
    peers: async () => peers,
    selectPeer: async (sel?: string) => {
      if (sel === undefined) return peers[0];
      const h = peers.find((p) => p.id === sel) ?? peers.find((p) => p.name === sel);
      if (!h) throw new Error(`server が見つからない: ${sel}`);
      return h;
    },
    statusOn: async (peer: ServerPeer) => ({
      bantou: 1,
      type: "status_result",
      ok: true,
      caps: (caps.get(peer.id) ?? []).map((id) => ({ kind: "cap", id })),
      workers: [],
    }),
    kickCapOn: (peer: ServerPeer, cmd: Record<string, unknown>) =>
      new Promise((resolve) => {
        kicks.push({ peer, cmd, resolve });
        // server は kick_cap で cap を作る（次の status には載る）
        caps.set(peer.id, [...new Set([...(caps.get(peer.id) ?? []), cmd.cap_id as string])]);
      }),
    stopCapOn: async (peer: ServerPeer, cmd: unknown) => {
      stops.push({ peer, cmd });
      // stop_cap は cap の実行を止めるだけで cap は残るが、delete 後の「作り直し」を試すため記録ごと server からも消す
      caps.set(peer.id, []);
      return { bantou: 1, type: "stop_result", ok: true, cap_id: (cmd as { cap_id: string }).cap_id, stopped: true };
    },
    ...over,
  } as unknown as ServerLink;
  const store = createJsonListStore<RemoteRecord>(join(dir, "remotes.json"), () => {});
  const mgr = createRemoteManager({ link, store, log: () => {}, capId: CAP, graceMs: GRACE, pollMs: POLL, ...(servers ? { servers } : {}), ...(activity ? { activity } : {}), ...(notify ? { notify } : {}), ...extra });
  return { mgr, kicks, stops, store, caps, setPeers: (p: ServerPeer[]) => (peers = p) };
}
/** テストでは猶予・追従間隔を短くする（本番は 15 秒）。 */
const GRACE = 60;
const POLL = 40;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 10));
const ok = (text: string) => ({ bantou: 1, type: "cap_result", cap_id: CAP, session_id: "s", ok: true, result_text: text });
const lateOk = (text: string) => ok(text) as never;

function notifier(fail?: string) {
  const sent: { owner: string; text: string }[] = [];
  const notify: Notify = async (owner, text) => {
    sent.push({ owner, text });
    return fail ? { ok: false, reason: fail } : { ok: true };
  };
  return { sent, notify };
}

const act = (state: string, workerState?: string, id = CAP) => ({
  bantou: 1 as const, type: "activity" as const, cap_id: id, at: "2026-11-04T00:00:00.000Z",
  agents: [
    { kind: "cap" as const, id, cap_id: id, state: state as never, task: "t", last_activity: null, last_output_at: null, silent_ms: 0, started_at: null, finished_at: null },
    ...(workerState ? [{ kind: "worker" as const, id: "w-1", cap_id: id, state: workerState as never, task: "t", last_activity: null, last_output_at: null, silent_ms: 0, started_at: null, finished_at: null }] : []),
  ],
});

// -- 指示は同じ cap_id の kick_cap。最初だけ cap を作る --

test("send: cap が無い時だけ最初の kick_cap（created）。status で cap の有無を確かめ、model は config の servers[] から", async () => {
  const servers = parseConfig({ servers: [{ name: "s1", peer: "bantou-server", model: "opus", workerModel: "haiku" }] }, "/x/c.json").servers;
  const { mgr, kicks } = setup({}, undefined, undefined, servers);
  const r = await mgr.send({ owner: "pm1", prompt: "go" });
  assert.deepEqual(r, { remote_id: CAP, server: "id-a", serverName: "bantou-server", state: "running", created: true, model: "opus", worker_model: "haiku" });
  assert.equal(kicks.length, 1);
  assert.equal(kicks[0].peer.id, "id-a");
  assert.deepEqual(kicks[0].cmd, { cap_id: CAP, prompt: "go", model: "opus", worker_model: "haiku", reason: "remote_send owner=pm1" });
  const saved = JSON.parse(await readFile(join(dir, "remotes.json"), "utf8")) as RemoteRecord[];
  assert.equal(saved.length, 1);
  assert.equal(saved[0].state, "running");
});

test("send: 設定に model が無ければ最初の kick_cap にも付けない", async () => {
  const { mgr, kicks } = setup();
  const r = await mgr.send({ owner: "pm1", prompt: "go" });
  assert.ok(!("model" in r) && !("worker_model" in r));
  assert.deepEqual(kicks[0].cmd, { cap_id: CAP, prompt: "go", reason: "remote_send owner=pm1" });
});

test("send: 2 回目の指示は同じ cap_id の kick_cap（resume）。cap があるので model は付けず、記録は 1 件のまま", async () => {
  const servers = parseConfig({ servers: [{ name: "s1", peer: "bantou-server", model: "opus" }] }, "/x/c.json").servers;
  const { mgr, kicks } = setup({}, undefined, undefined, servers);
  const first = await mgr.send({ owner: "pm1", prompt: "one" });
  kicks[0].resolve(ok("r1"));
  await tick();
  const second = await mgr.send({ owner: "pm1", prompt: "two" });
  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(kicks.length, 2);
  assert.equal(kicks[1].cmd.cap_id, CAP);
  assert.deepEqual(kicks[1].cmd, { cap_id: CAP, prompt: "two", reason: "remote_send owner=pm1" });
  assert.equal(mgr.list().length, 1);
  assert.equal(second.remote_id, first.remote_id);
});

test("send: 前の指示の返信を待たずに続けて送っても、同じ cap_id で 2 本とも kick_cap になる（記録は 1 件）", async () => {
  const { mgr, kicks } = setup();
  await mgr.send({ owner: "pm1", prompt: "one" });
  const second = await mgr.send({ owner: "pm2", prompt: "two" });
  assert.equal(second.created, false);
  assert.deepEqual(kicks.map((k) => [k.cmd.cap_id, k.cmd.prompt]), [[CAP, "one"], [CAP, "two"]]);
  assert.equal(mgr.list().length, 1);
  assert.equal(mgr.list()[0].state, "running");
});

test("send: 同時に 2 本送っても最初の kick_cap は 1 本だけ（server ごとに直列）", async () => {
  const { mgr, kicks } = setup();
  const [a, b] = await Promise.all([mgr.send({ owner: "pm1", prompt: "a" }), mgr.send({ owner: "pm2", prompt: "b" })]);
  assert.deepEqual([a.created, b.created].sort(), [false, true]);
  assert.equal(kicks.length, 2);
  assert.equal(mgr.list().length, 1);
});

test("send: server に cap があるのに center の記録が無い時は、記録を作って model なしの resume として送る", async () => {
  const servers = parseConfig({ servers: [{ name: "s1", peer: "bantou-server", model: "opus" }] }, "/x/c.json").servers;
  const { mgr, kicks, caps } = setup({}, undefined, undefined, servers);
  caps.set("id-a", [CAP]);
  const r = await mgr.send({ owner: "pm1", prompt: "go" });
  assert.equal(r.created, false);
  assert.ok(!("model" in kicks[0].cmd));
  assert.equal(mgr.list().length, 1);
});

test("send: server に cap が無くなっていれば、記録があっても最初の kick_cap に戻る", async () => {
  const servers = parseConfig({ servers: [{ name: "s1", peer: "bantou-server", model: "opus" }] }, "/x/c.json").servers;
  const { mgr, kicks, caps } = setup({}, undefined, undefined, servers);
  await mgr.send({ owner: "pm1", prompt: "one" });
  kicks[0].resolve(ok("r1"));
  await tick();
  caps.clear();
  const r = await mgr.send({ owner: "pm1", prompt: "two" });
  assert.equal(r.created, true);
  assert.equal(kicks[1].cmd.model, "opus");
});

test("send: status が error なら cap の有無が分からないので送らず、記録も作らない", async () => {
  const { mgr, kicks } = setup({ statusOn: async () => ({ bantou: 1, type: "error", ok: false, message: "タイムアウト", command: "status" }) as never });
  await assert.rejects(mgr.send({ owner: "o", prompt: "p" }), /cap を確かめられない: タイムアウト/);
  assert.equal(kicks.length, 0);
  assert.equal(mgr.list().length, 0);
});

test("send: server は peer id か名前で指定でき、server ごとに記録（cap）が 1 件。見つからなければ記録を作らず失敗", async () => {
  const { mgr, kicks } = setup();
  assert.equal((await mgr.send({ owner: "o", prompt: "p", server: "id-b" })).serverName, "other");
  assert.equal((await mgr.send({ owner: "o", prompt: "p", server: "bantou-server" })).server, "id-a");
  await assert.rejects(mgr.send({ owner: "o", prompt: "p", server: "zzz" }), /見つからない/);
  assert.equal(mgr.list().length, 2);
  assert.equal(kicks.length, 2);
  assert.equal(kicks[0].cmd.cap_id, kicks[1].cmd.cap_id);
});

test("send: owner 形式が不正なら拒否", async () => {
  const { mgr } = setup();
  await assert.rejects(mgr.send({ owner: "a b", prompt: "p" }), /owner/);
});

test("send: 門が断る（protocol の版違い・更新待ち）時は投げ、記録も kick_cap も作らない", async () => {
  const { mgr, kicks } = setup({ gate: () => ({ bantou: 1, type: "error", ok: false, message: "更新待ち", code: "updating", retryable: true }) } as never);
  await assert.rejects(mgr.send({ owner: "o", prompt: "p" }), /更新待ち/);
  assert.equal(mgr.list().length, 0);
  assert.equal(kicks.length, 0);
});

test("schema: remote_send / remote_create は prompt・server・model・worker_model（repo は受けない）。model は protocol と同じ形式で検証", () => {
  assert.equal(remoteCreateSchema, remoteSendSchema);
  const s = z.object(remoteSendSchema);
  assert.deepEqual(s.parse({ prompt: "x", server: "s", model: "opus", repo: "r", worker_model: "haiku" }), { prompt: "x", server: "s", model: "opus", worker_model: "haiku" });
  assert.deepEqual(s.parse({ prompt: "x", model: "claude-opus-4-8[1m]" }), { prompt: "x", model: "claude-opus-4-8[1m]" });
  for (const bad of ["a b", "-x", "a;b", ""]) {
    assert.ok(!s.safeParse({ prompt: "x", model: bad }).success, `model=${bad}`);
    assert.ok(!s.safeParse({ prompt: "x", worker_model: bad }).success, `worker_model=${bad}`);
  }
  assert.ok(!s.safeParse({ prompt: "" }).success);
  assert.ok(!s.safeParse({ prompt: "a\0b" }).success);
});

// -- 返信・履歴 --

test("返信で state が done / failed に更新され、結果が履歴（指示と結果）に積まれる", async () => {
  const { mgr, kicks } = setup();
  await mgr.send({ owner: "pm1", prompt: "one" });
  kicks[0].resolve(ok("OK!"));
  await tick();
  mgr.onActivity(CAP);
  await tick();
  let r = mgr.list()[0];
  assert.equal(r.state, "done");
  assert.equal(r.result, "OK!");
  assert.ok(r.finishedAt);
  await mgr.send({ owner: "pm2", prompt: "two" });
  kicks[1].resolve({ bantou: 1, type: "error", ok: false, message: "boom", command: "kick_cap", cap_id: CAP });
  await tick();
  mgr.onActivity(CAP);
  await tick();
  r = mgr.list()[0];
  assert.deepEqual([r.state, r.error, r.result], ["failed", "boom", "OK!"]);
  assert.deepEqual(r.history.map((e) => e.type), ["instruction", "result", "instruction", "result"]);
  assert.deepEqual(r.owners, ["pm1", "pm2"]);
  const i0 = r.history[0] as { owner: string; prompt: string; at: string };
  assert.deepEqual([i0.owner, i0.prompt], ["pm1", "one"]);
  assert.ok(i0.at);
  assert.deepEqual((r.history[1] as { ok: boolean; text: string }).text, "OK!");
  assert.deepEqual([(r.history[3] as { ok: boolean }).ok, (r.history[3] as { error?: string }).error], [false, "boom"]);
});

test("履歴の prompt は先頭 200 文字だけ。kick_cap には全文", async () => {
  const { mgr, kicks } = setup();
  const long = "x".repeat(500);
  await mgr.send({ owner: "o", prompt: long });
  assert.equal((mgr.list()[0].history[0] as { prompt: string }).prompt.length, 200);
  assert.equal(kicks[0].cmd.prompt, long);
});

test("送信自体の失敗（server に届かない reject）は failed でなく unknown。status が取れたら戻り、完了を通知する", async () => {
  const n = notifier();
  let down = false;
  const { mgr } = setup({ kickCapOn: async () => { throw new Error("link down"); }, statusOn: async () => { if (down) throw new Error("no peer"); return { bantou: 1, type: "status_result", ok: true, caps: [{ kind: "cap", id: CAP, state: "idle" }], workers: [] } as never; } }, undefined, n.notify);
  await mgr.send({ owner: "o", prompt: "p" });
  down = true; // 送信後は status も取れない
  await tick();
  assert.deepEqual([mgr.list()[0].state, mgr.list()[0].error], ["unknown", "link down"]);
  await sleep(POLL * 2 + 30); // status も取れない間は unknown のまま。通知しない
  assert.equal(mgr.list()[0].state, "unknown");
  assert.match(mgr.list()[0].error ?? "", /status を取れない/);
  assert.equal(n.sent.length, 0);
  down = false;
  await sleep(POLL * 2 + 30);
  assert.equal(mgr.list()[0].state, "done");
  assert.equal(n.sent.length, 1);
});

test("送信の error 返信（server が断った）は failed のまま", async () => {
  const { mgr, kicks } = setup();
  await mgr.send({ owner: "o", prompt: "p" });
  kicks[0].resolve({ bantou: 1, type: "error", ok: false, message: "updating", command: "kick_cap", cap_id: CAP });
  await tick();
  assert.equal(mgr.list()[0].state, "failed");
});

test("list: owner はその owner が指示を送った cap だけ。返り値の変更は内部に影響しない", async () => {
  const { mgr } = setup();
  await mgr.send({ owner: "a", prompt: "p" });
  await mgr.send({ owner: "b", prompt: "p", server: "id-b" });
  assert.deepEqual(mgr.list({ owner: "a" }).map((r) => r.server), ["id-a"]);
  assert.deepEqual(mgr.list({ owner: "b" }).map((r) => r.server), ["id-b"]);
  assert.equal(mgr.list().length, 2);
  mgr.list()[0].state = "done";
  mgr.list()[0].history.length = 0;
  assert.equal(mgr.list()[0].state, "running");
  assert.equal(mgr.list()[0].history.length, 1);
});

test("履歴は 200 件を超えたら古い完了済みから捨てる（未完了の指示は残す）", async () => {
  const { mgr, kicks } = setup();
  for (let i = 0; i < 110; i++) {
    await mgr.send({ owner: "o", prompt: `p${i}` });
    kicks[i].resolve(ok(`r${i}`));
    await tick();
  }
  const h = mgr.list()[0].history;
  assert.equal(h.length, 200);
  assert.equal((h[h.length - 1] as { text: string }).text, "r109");
});

// -- 完了判定と通知 --

test("通知: 指示を送った session へ、cap が idle で worker 無しになった時に 1 回。指示の先頭・state・result を含む", async () => {
  const n = notifier();
  const { mgr, kicks } = setup({}, undefined, n.notify);
  await mgr.send({ owner: "pm1", prompt: "調べて" });
  assert.equal(n.sent.length, 0);
  kicks[0].resolve(ok("調査結果"));
  await tick();
  mgr.onActivity(CAP);
  await tick();
  assert.equal(n.sent.length, 1);
  assert.equal(n.sent[0].owner, "pm1");
  assert.match(n.sent[0].text, new RegExp(`remote_id=${CAP} state=done`));
  assert.match(n.sent[0].text, /指示: 調べて/);
  assert.match(n.sent[0].text, /result: 調査結果/);
  const i = mgr.list()[0].history[0] as { done_at?: string; notified_at?: string };
  assert.ok(i.done_at && i.notified_at);
  // 同じ結果の再受信・activity の繰り返しでは送り直さない
  mgr.applyLateReply(lateOk("調査結果"));
  mgr.onActivity(CAP);
  await tick();
  assert.equal(n.sent.length, 1);
});

test("通知: failed（error 返信）も error 付きで送る", async () => {
  const n = notifier();
  const { mgr, kicks } = setup({}, undefined, n.notify);
  await mgr.send({ owner: "pm1", prompt: "p" });
  kicks[0].resolve({ bantou: 1, type: "error", ok: false, message: "updating", command: "kick_cap", cap_id: CAP });
  await tick();
  assert.match(n.sent[0].text, /state=failed/);
  assert.match(n.sent[0].text, /error: updating/);
});

test("通知: 複数 session の指示が重なっても、cap が idle になるまで送らず、idle になった時に未完了を全て完了にして各 owner へ 1 回ずつ", async () => {
  const n = notifier();
  const { mgr, kicks } = setup({}, undefined, n.notify);
  await mgr.send({ owner: "pm1", prompt: "A" });
  await mgr.send({ owner: "pm2", prompt: "B" });
  await mgr.send({ owner: "pm1", prompt: "C" });
  // 1 本目の返信: 後ろに返信待ちの指示がある間は完了にしない
  kicks[0].resolve(ok("r-A"));
  await tick();
  mgr.onActivity(CAP);
  await tick();
  assert.equal(n.sent.length, 0);
  assert.equal(mgr.list()[0].state, "running");
  kicks[1].resolve(ok("r-B"));
  await tick();
  mgr.onActivity(CAP);
  await tick();
  assert.equal(n.sent.length, 0);
  // 最後の返信で、3 本とも完了。owner ごとに 1 通
  kicks[2].resolve(ok("r-C"));
  await tick();
  mgr.onActivity(CAP);
  await tick();
  assert.deepEqual(n.sent.map((s) => s.owner).sort(), ["pm1", "pm2"]);
  const pm1 = n.sent.find((s) => s.owner === "pm1")!;
  assert.match(pm1.text, /指示: A \/ C/);
  assert.match(pm1.text, /result: r-C/);
  assert.match(n.sent.find((s) => s.owner === "pm2")!.text, /指示: B/);
  const instr = mgr.list()[0].history.filter((e) => e.type === "instruction") as { done_at?: string; notified_at?: string }[];
  assert.ok(instr.every((i) => i.done_at && i.notified_at));
});

test("通知: 通知先は指示を送った session だけ（別 session の指示は別の通知）。完了後の新しい指示は新しい通知", async () => {
  const n = notifier();
  const { mgr, kicks } = setup({}, undefined, n.notify);
  await mgr.send({ owner: "pm1", prompt: "A" });
  kicks[0].resolve(ok("rA"));
  await tick();
  mgr.onActivity(CAP);
  await tick();
  assert.deepEqual(n.sent.map((s) => s.owner), ["pm1"]);
  await mgr.send({ owner: "pm2", prompt: "B" });
  kicks[1].resolve(ok("rB"));
  await tick();
  mgr.onActivity(CAP);
  await tick();
  assert.deepEqual(n.sent.map((s) => s.owner), ["pm1", "pm2"]);
  assert.match(n.sent[1].text, /result: rB/);
  assert.doesNotMatch(n.sent[1].text, /指示: .*A/);
});

test("通知: worker が running / stalled の間は送らず、全部終わった activity 通知で 1 回だけ送る", async () => {
  const n = notifier();
  const activity = createActivityStore();
  const { mgr, kicks } = setup({}, activity, n.notify);
  await mgr.send({ owner: "pm1", prompt: "p" });
  activity.apply(act("idle", "running"), "id-a");
  kicks[0].resolve(ok("first"));
  await tick();
  assert.equal(n.sent.length, 0);
  assert.equal(mgr.list()[0].state, "running");
  activity.apply(act("idle", "stalled"), "id-a");
  mgr.onActivity(CAP, "id-a");
  await tick();
  assert.equal(n.sent.length, 0);
  activity.apply(act("idle", "done"), "id-a");
  mgr.onActivity(CAP, "id-a");
  mgr.onActivity(CAP, "id-a");
  await tick();
  assert.equal(n.sent.length, 1);
  assert.equal(mgr.list()[0].state, "done");
});

test("通知: cap 自身が再開して running の間は送らない", async () => {
  const n = notifier();
  const activity = createActivityStore();
  const { mgr, kicks } = setup({}, activity, n.notify);
  await mgr.send({ owner: "pm1", prompt: "p" });
  activity.apply(act("running"), "id-a");
  kicks[0].resolve(ok("first"));
  await tick();
  assert.equal(n.sent.length, 0);
  assert.equal(mgr.list()[0].state, "running");
  activity.apply(act("idle"), "id-a");
  mgr.onActivity(CAP, "id-a");
  await tick();
  assert.equal(n.sent.length, 1);
});

test("通知: 送れない時は指示に notify_error を残し、再送しない。送れた時は notify_error が消える", async () => {
  const n = notifier("peer がいない");
  const { mgr, kicks } = setup({}, undefined, n.notify);
  await mgr.send({ owner: "pm1", prompt: "p" });
  kicks[0].resolve(ok("r"));
  await tick();
  mgr.onActivity(CAP);
  await tick();
  const i = mgr.list()[0].history[0] as { notified_at?: string; notify_error?: string };
  assert.equal(i.notify_error, "peer がいない");
  assert.equal(i.notified_at, undefined);
  mgr.onActivity(CAP);
  await tick();
  assert.equal(n.sent.length, 1);
});

test("通知: notify が throw しても記録に残り、落ちない。notify 無しなら理由を残す", async () => {
  const { mgr, kicks } = setup({}, undefined, (async () => { throw new Error("push 失敗"); }) as Notify);
  await mgr.send({ owner: "pm1", prompt: "p" });
  kicks[0].resolve(ok("r"));
  await tick();
  mgr.onActivity(CAP);
  await tick();
  assert.equal((mgr.list()[0].history[0] as { notify_error?: string }).notify_error, "push 失敗");
  const b = setup();
  await b.mgr.send({ owner: "pm1", prompt: "p" });
  b.kicks[0].resolve(ok("r"));
  await tick();
  b.mgr.onActivity(CAP);
  await tick();
  assert.match((b.mgr.list()[0].history[0] as { notify_error?: string }).notify_error ?? "", /通知の送り先が無い/);
});

// -- applyLateReply --

test("applyLateReply: 最初の返信の後の cap_result で result が最新になり、履歴に積まれる。失敗なら failed、次の成功で done に戻る", async () => {
  const { mgr, kicks } = setup();
  await mgr.send({ owner: "o", prompt: "p" });
  kicks[0].resolve(ok("first"));
  await tick();
  mgr.onActivity(CAP);
  await tick();
  assert.equal(mgr.applyLateReply(lateOk("second")), true);
  assert.equal(mgr.list()[0].result, "second");
  assert.equal(mgr.applyLateReply({ bantou: 1, type: "cap_result", cap_id: CAP, session_id: "s", ok: false, result_text: "partial", error: "kill" } as never), true);
  let r = mgr.list()[0];
  assert.deepEqual([r.state, r.error, r.result], ["failed", "kill", "partial"]);
  mgr.applyLateReply(lateOk("third"));
  r = mgr.list()[0];
  assert.deepEqual([r.state, r.error, r.result], ["done", undefined, "third"]);
  assert.equal(r.history.filter((e) => e.type === "result").length, 4);
});

test("applyLateReply: kick_cap の error は failed + error。結果本文は残す", async () => {
  const { mgr, kicks } = setup();
  await mgr.send({ owner: "o", prompt: "p" });
  kicks[0].resolve(ok("keep"));
  await tick();
  mgr.onActivity(CAP);
  await tick();
  mgr.applyLateReply({ bantou: 1, type: "error", ok: false, message: "resume 失敗", command: "kick_cap", cap_id: CAP });
  const r = mgr.list()[0];
  assert.deepEqual([r.state, r.error, r.result], ["failed", "resume 失敗", "keep"]);
});

test("applyLateReply: 記録なし・返信待ちの指示がある間・delete 済み・cap_id 違いは無視", async () => {
  const { mgr, kicks } = setup();
  assert.equal(mgr.applyLateReply(lateOk("x")), false);
  await mgr.send({ owner: "o", prompt: "p" });
  assert.equal(mgr.applyLateReply(lateOk("x")), false);
  kicks[0].resolve(ok("first"));
  await tick();
  assert.equal(mgr.applyLateReply({ ...ok("x"), cap_id: "other" } as never), false);
  await mgr.delete({});
  assert.equal(mgr.applyLateReply(lateOk("late")), false);
  assert.equal(mgr.list().length, 0);
});

test("applyLateReply / onActivity: 同じ cap_id が複数 server にある時は送信元の peer id で記録を決める", async () => {
  const n = notifier();
  const { mgr, kicks } = setup({}, undefined, n.notify);
  await mgr.send({ owner: "o", prompt: "a" });
  await mgr.send({ owner: "o", prompt: "b", server: "id-b" });
  kicks[0].resolve(ok("A"));
  kicks[1].resolve(ok("B"));
  await tick();
  assert.equal(mgr.applyLateReply(lateOk("B2"), "id-b"), true);
  const by = Object.fromEntries(mgr.list().map((r) => [r.server, r]));
  assert.equal(by["id-a"].result, "A");
  assert.equal(by["id-b"].result, "B2");
  // 送信元が分からず記録が 2 件なら、取り違えを避けて無視
  assert.equal(mgr.applyLateReply(lateOk("?")), false);
});

// -- state と activity --

test("list: cap が done でも配下の worker が running / stalled の間は running。全員終われば done。failed は変えない", async () => {
  const activity = createActivityStore();
  const { mgr, kicks } = setup({}, activity);
  await mgr.send({ owner: "o", prompt: "p" });
  kicks[0].resolve(ok("done"));
  await tick();
  mgr.onActivity(CAP);
  await tick();
  activity.apply(act("idle", "running"), "id-a");
  assert.equal(mgr.list()[0].state, "running");
  assert.equal(mgr.list()[0].finishedAt, undefined);
  activity.apply(act("idle", "stalled"), "id-a");
  assert.equal(mgr.list()[0].state, "running");
  activity.apply(act("idle", "done"), "id-a");
  assert.equal(mgr.list()[0].state, "done");
  mgr.applyLateReply({ bantou: 1, type: "error", ok: false, message: "x", command: "kick_cap", cap_id: CAP });
  activity.apply(act("idle", "running"), "id-a");
  assert.equal(mgr.list()[0].state, "failed");
});

test("list: activity 通知のある cap には activity が付き、delete で忘れる。store が無ければ activity キーは付かない", async () => {
  let now = 1_000_000;
  const activity = createActivityStore({ now: () => now });
  const { mgr } = setup({}, activity);
  await mgr.send({ owner: "a", prompt: "p" });
  activity.apply(act("running"), "id-a");
  now += 2000;
  const r = mgr.list()[0];
  assert.equal(r.activity?.received_ms_ago, 2000);
  assert.equal(r.activity?.agents[0].id, CAP);
  await mgr.delete({ force: true });
  assert.equal(activity.get(CAP, "id-a"), undefined);
  const b = setup();
  await b.mgr.send({ owner: "a", prompt: "p" });
  assert.equal("activity" in b.mgr.list()[0], false);
});

test("activity: scope（server の peer id）ごとに別々に持つ", () => {
  const activity = createActivityStore();
  activity.apply(act("running"), "id-a");
  activity.apply(act("idle"), "id-b");
  assert.equal(activity.get(CAP, "id-a")?.agents[0].state, "running");
  assert.equal(activity.get(CAP, "id-b")?.agents[0].state, "idle");
  assert.equal(activity.get(CAP), undefined);
  activity.forget(CAP, "id-a");
  assert.equal(activity.get(CAP, "id-a"), undefined);
});

// -- wait --

test("remote_wait: cap が idle で worker 無しになるまで待って結果を返す。すでに終わっていれば即返す", async () => {
  const { mgr, kicks } = setup();
  await mgr.send({ owner: "pm1", prompt: "p" });
  const w = mgr.wait({ remote_id: CAP, timeoutSec: 5 });
  await tick();
  kicks[0].resolve(ok("fin"));
  await tick();
  mgr.onActivity(CAP);
  const v = await w;
  assert.deepEqual([v.state, v.result], ["done", "fin"]);
  assert.equal((await mgr.wait({ remote_id: CAP, timeoutSec: 1 })).state, "done");
});

test("remote_wait: worker が動いている間は待ち、全部終わった activity 通知で返る", async () => {
  const activity = createActivityStore();
  const { mgr, kicks } = setup({}, activity);
  await mgr.send({ owner: "pm1", prompt: "p" });
  activity.apply(act("idle", "running"), "id-a");
  kicks[0].resolve(ok("fin"));
  let state: string | undefined;
  const w = mgr.wait({ owner: "pm1", timeoutSec: 5 }).then((v) => (state = v.state));
  await tick();
  assert.equal(state, undefined);
  activity.apply(act("idle", "done"), "id-a");
  mgr.onActivity(CAP, "id-a");
  await w;
  assert.equal(state, "done");
});

test("remote_wait: remote_id 省略は owner の未完了の指示がある cap。無ければ error。未定義の remote_id・owner 無しは error", async () => {
  const { mgr, kicks } = setup();
  await assert.rejects(mgr.wait({ owner: "pm1" }), /running の remote が無い/);
  await mgr.send({ owner: "pm1", prompt: "p" });
  await assert.rejects(mgr.wait({ owner: "pm2" }), /running の remote が無い/);
  await assert.rejects(mgr.wait({}), /owner/);
  await assert.rejects(mgr.wait({ remote_id: "zzz" }), /未定義/);
  kicks[0].resolve(ok("x"));
  await tick();
  mgr.onActivity(CAP);
  await tick();
  await assert.rejects(mgr.wait({ owner: "pm1" }), /running の remote が無い/);
  // どの session からでも同じ cap を remote_id で待てる
  assert.equal((await mgr.wait({ remote_id: CAP, owner: "pm2" })).state, "done");
});

test("remote_wait: 複数 server に同じ remote_id がある時は server で絞る", async () => {
  const { mgr, kicks } = setup();
  await mgr.send({ owner: "o", prompt: "a" });
  await mgr.send({ owner: "o", prompt: "b", server: "id-b" });
  kicks[1].resolve(ok("B"));
  await tick();
  await assert.rejects(mgr.wait({ remote_id: CAP, timeoutSec: 1 }), /複数の server/);
  assert.equal((await mgr.wait({ remote_id: CAP, server: "id-b", timeoutSec: 1 })).serverName, "other");
  const t = await mgr.wait({ server: "id-a", timeoutSec: 1 });
  assert.equal(t.state, "running");
});

test("remote_wait: timeout なら state=running のまま返す。待ち中の delete は error", async () => {
  const { mgr } = setup();
  await mgr.send({ owner: "pm1", prompt: "p" });
  assert.equal((await mgr.wait({ remote_id: CAP, timeoutSec: 1 })).state, "running");
  const w = mgr.wait({ remote_id: CAP, timeoutSec: 5 });
  const caught = w.then(() => "resolved", (e: Error) => e.message);
  await tick();
  await mgr.delete({ force: true });
  assert.match(await caught, /削除された/);
});

// -- delete --

test("remote_delete: stop_cap を同じ cap_id で送って記録を外す。外した後の遅れた返信は記録を復活させない", async () => {
  const { mgr, kicks, stops } = setup();
  await mgr.send({ owner: "a", prompt: "p" });
  const r = await mgr.delete({ remote_id: CAP });
  assert.deepEqual(r, { remote_id: CAP, deleted: true, stopped: true });
  assert.deepEqual(stops.map((s) => [s.peer.id, s.cmd]), [["id-a", { cap_id: CAP }]]);
  assert.equal(mgr.list().length, 0);
  kicks[0].resolve({ ...ok(""), ok: false, error: "stop_cap により停止" });
  await tick();
  assert.equal(mgr.list().length, 0);
  assert.deepEqual(JSON.parse(await readFile(join(dir, "remotes.json"), "utf8")), []);
  // 消した後の指示は最初の kick_cap からやり直す
  assert.equal((await mgr.send({ owner: "a", prompt: "again" })).created, true);
});

test("remote_delete: remote_id 省略は center の cap。未定義は拒否。どの session からでも消せる（owner を見ない）", async () => {
  const { mgr } = setup();
  await assert.rejects(mgr.delete({}), /未定義の remote/);
  await mgr.send({ owner: "a", prompt: "p" });
  await assert.rejects(mgr.delete({ remote_id: "zzz" }), /未定義/);
  assert.equal((await mgr.delete({})).deleted, true);
});

test("remote_delete: 複数 server にある時は server で指定する", async () => {
  const { mgr, stops } = setup();
  await mgr.send({ owner: "a", prompt: "p" });
  await mgr.send({ owner: "a", prompt: "p", server: "id-b" });
  await assert.rejects(mgr.delete({}), /複数の server/);
  await mgr.delete({ server: "id-b" });
  assert.deepEqual(stops.map((s) => s.peer.id), ["id-b"]);
  assert.deepEqual(mgr.list().map((r) => r.server), ["id-a"]);
});

test("remote_delete: server の peer id が変わっていても名前 + host で探して stop を送る。居なければ running は拒否、force で記録だけ消す", async () => {
  const { mgr, stops, setPeers } = setup();
  await mgr.send({ owner: "a", prompt: "p" });
  setPeers([{ id: "id-a2", name: "bantou-server", hostname: "host-a" }, peerB]);
  await mgr.delete({});
  assert.equal(stops[0].peer.id, "id-a2");
  await mgr.send({ owner: "a", prompt: "p" });
  setPeers([peerB]);
  await assert.rejects(mgr.delete({}), /止められない/);
  assert.equal(mgr.list().length, 1);
  const r = await mgr.delete({ force: true });
  assert.match(r.warning ?? "", /stop_cap を送れなかった/);
  assert.equal(mgr.list().length, 0);
});

test("remote_delete: stop が error 返信なら running は拒否。終わった記録は警告付きで消せる", async () => {
  const { mgr, kicks } = setup({ stopCapOn: async () => ({ bantou: 1, type: "error", ok: false, message: "kill 失敗", command: "stop_cap" }) as never });
  await mgr.send({ owner: "a", prompt: "p" });
  await assert.rejects(mgr.delete({}), /kill 失敗/);
  kicks[0].resolve(ok("x"));
  await tick();
  mgr.onActivity(CAP);
  await tick();
  const r = await mgr.delete({});
  assert.match(r.warning ?? "", /kill 失敗/);
});

// -- restore / 旧形式 --

// -- 完了判定の競合（cap_result 直後の activity）と status 判定 --

/** server の status の差し替え。caps は常に CAP を 1 つ持つ。 */
const statusOf = (capState: string, workers: string[] = []) =>
  ({ bantou: 1, type: "status_result", ok: true, caps: [{ kind: "cap", id: CAP, state: capState, queued: 0 }], workers: workers.map((state, i) => ({ kind: "worker", id: `w-${i}`, state })) }) as never;

test("競合: activity（cap=running, worker=running）の後に最初の cap_result が来ても完了にしない。直後の activity（cap=idle, worker=running）も無視せず、worker が終わるまで完了にしない", async () => {
  const n = notifier();
  const activity = createActivityStore();
  const { mgr, kicks } = setup({}, activity, n.notify);
  await mgr.send({ owner: "pm1", prompt: "p" });
  activity.apply(act("running", "running"), "id-a");
  mgr.onActivity(CAP, "id-a");
  // 実機で起きた順序: cap_result の直後に cap=idle の activity が来る（activity の store を更新しない先に cap_result が処理される）
  activity.apply(act("running", "running"), "id-a"); // store の内容はまだ古い
  kicks[0].resolve(ok("first"));
  await tick();
  assert.equal(mgr.list()[0].state, "running");
  assert.equal(n.sent.length, 0);
  activity.apply(act("idle", "running"), "id-a");
  mgr.onActivity(CAP, "id-a");
  await tick();
  assert.equal(mgr.list()[0].state, "running");
  assert.equal(n.sent.length, 0);
  // 猶予が過ぎても、activity が来ていれば（settling は解けている）status を取らず activity で判定し続ける
  await sleep(GRACE + 40);
  assert.equal(mgr.list()[0].state, "running");
  assert.equal(n.sent.length, 0);
  activity.apply(act("idle", "done"), "id-a");
  mgr.onActivity(CAP, "id-a");
  await tick();
  assert.equal(n.sent.length, 1);
  assert.equal(mgr.list()[0].state, "done");
});

test("競合: cap_result の時点で store の activity が cap=idle・worker 無しでも、次の activity（または猶予）まで完了にしない", async () => {
  const n = notifier();
  const activity = createActivityStore();
  const { mgr, kicks } = setup({}, activity, n.notify);
  await mgr.send({ owner: "pm1", prompt: "p" });
  activity.apply(act("idle"), "id-a"); // 前の指示のときの idle が残っている
  kicks[0].resolve(ok("first"));
  await tick();
  assert.equal(mgr.list()[0].state, "running");
  assert.equal(n.sent.length, 0);
  // 次の activity が worker=running を運んでくる
  activity.apply(act("idle", "running"), "id-a");
  mgr.onActivity(CAP, "id-a");
  await tick();
  assert.equal(n.sent.length, 0);
  activity.apply(act("idle", "done"), "id-a");
  mgr.onActivity(CAP, "id-a");
  await tick();
  assert.equal(n.sent.length, 1);
});

test("猶予後の status 判定: activity が来ないまま猶予を過ぎたら status を取り、cap idle・worker 無しなら完了にして通知（1 回）", async () => {
  const n = notifier();
  let statusCalls = 0;
  const { mgr, kicks } = setup({ statusOn: async () => (statusCalls++ === 0 ? statusOf("idle") : statusOf("idle")) }, undefined, n.notify);
  await mgr.send({ owner: "pm1", prompt: "p" }); // status 1 回目（send の cap 確認）
  const before = statusCalls;
  kicks[0].resolve(ok("fin"));
  await tick();
  assert.equal(mgr.list()[0].state, "running");
  assert.equal(n.sent.length, 0);
  assert.equal(statusCalls, before); // 猶予の間は status を取らない
  await sleep(GRACE + 60);
  assert.ok(statusCalls > before);
  assert.equal(mgr.list()[0].state, "done");
  assert.equal(n.sent.length, 1);
  assert.match(n.sent[0].text, /result: fin/);
});

test("猶予後の status 判定: store に cap_result 前の古い activity（running）が残っていても、status が idle なら完了にして通知する", async () => {
  const n = notifier();
  const activity = createActivityStore();
  const { mgr, kicks } = setup({ statusOn: async () => statusOf("idle") }, activity, n.notify);
  await mgr.send({ owner: "pm1", prompt: "p" });
  activity.apply(act("running", "running"), "id-a"); // cap_result 前の通知。以後 activity は来ない
  kicks[0].resolve(ok("fin"));
  await tick();
  assert.equal(mgr.list()[0].state, "running");
  await sleep(GRACE + 60);
  assert.equal(mgr.list()[0].state, "done");
  assert.equal(n.sent.length, 1);
  // その後に届いた新しい activity は使う（worker が再び running なら running に戻る）
  await sleep(5);
  activity.apply(act("idle", "running"), "id-a");
  assert.equal(mgr.list()[0].state, "running");
});

test("猶予後の status 判定: worker が running なら完了にせず追従し、終わったら完了にして 1 回だけ通知", async () => {
  const n = notifier();
  let workers: string[] = [];
  let sends = true;
  const { mgr, kicks } = setup({ statusOn: async () => (sends ? statusOf("idle") : statusOf("idle", workers)) }, undefined, n.notify);
  await mgr.send({ owner: "pm1", prompt: "p" });
  sends = false;
  workers = ["running"];
  kicks[0].resolve(ok("fin"));
  await tick();
  await sleep(GRACE + POLL * 2);
  assert.equal(mgr.list()[0].state, "running");
  assert.equal(n.sent.length, 0);
  workers = [];
  await sleep(POLL * 2 + 40);
  assert.equal(mgr.list()[0].state, "done");
  assert.equal(n.sent.length, 1);
});

test("remote_wait: unknown の間は返らず待ち、status が取れて done になれば返る。timeout なら unknown のまま返す", async () => {
  let down = false;
  const { mgr } = setup({ kickCapOn: async () => { throw new Error("link down"); }, statusOn: async () => { if (down) throw new Error("no peer"); return statusOf("idle"); } });
  await mgr.send({ owner: "o", prompt: "p" });
  down = true;
  await tick();
  assert.equal(mgr.list()[0].state, "unknown");
  const t0 = Date.now();
  const timedOut = await mgr.wait({ remote_id: CAP, timeoutSec: 1 });
  assert.equal(timedOut.state, "unknown");
  assert.ok(Date.now() - t0 >= 900);
  const w = mgr.wait({ remote_id: CAP, timeoutSec: 5 });
  down = false;
  assert.equal((await w).state, "done");
});

// -- center 再起動 --

/** 再起動前の記録（running、未完了の指示 1 件）を store に書く。 */
async function seedRunning(extra: Partial<RemoteRecord> = {}): Promise<void> {
  const rec: RemoteRecord = {
    remote_id: CAP, server: "id-old", serverName: "bantou-server", serverHost: "host-a", state: "running", createdAt: "2026-11-04T00:00:00.000Z",
    history: [{ type: "instruction", at: "2026-11-04T00:00:01.000Z", owner: "pm1", prompt: "再起動をまたぐ指示" }], ...extra,
  };
  await writeFile(join(dir, "remotes.json"), JSON.stringify([rec]));
}

test("restore: running は failed にせず running のまま復元し、未完了の指示も閉じない。status で cap が動いていれば追従", async () => {
  await seedRunning();
  const n = notifier();
  const { mgr } = setup({ statusOn: async () => statusOf("running") }, undefined, n.notify);
  await mgr.restore();
  assert.equal(mgr.list()[0].state, "running");
  await sleep(GRACE + POLL * 2);
  const r = mgr.list()[0];
  assert.equal(r.state, "running");
  assert.equal(r.error, undefined);
  assert.equal((r.history[0] as { done_at?: string }).done_at, undefined);
  assert.equal(n.sent.length, 0);
});

test("restore: status で cap idle・worker 無しなら（猶予の後）完了にして owner へ 1 回通知。peer id が変わっていても名前 + host で探す", async () => {
  await seedRunning();
  const n = notifier();
  const { mgr } = setup({ statusOn: async () => statusOf("idle") }, undefined, n.notify);
  await mgr.restore();
  assert.equal(mgr.list()[0].state, "running"); // 猶予の間は遅れた cap_result を待つ
  await sleep(GRACE + POLL * 2);
  assert.equal(mgr.list()[0].state, "done");
  assert.equal(n.sent.length, 1);
  assert.equal(n.sent[0].owner, "pm1");
  assert.match(n.sent[0].text, /指示: 再起動をまたぐ指示/);
});

test("restore: 再起動後に届く cap_result（onLateCapReply）は履歴と最新 result に反映し、完了になれば owner へ通知する", async () => {
  await seedRunning();
  const n = notifier();
  const activity = createActivityStore();
  const { mgr } = setup({ statusOn: async () => statusOf("idle") }, activity, n.notify);
  await mgr.restore();
  assert.equal(mgr.applyLateReply(lateOk("再起動後に届いた結果"), "id-a"), true);
  let r = mgr.list()[0];
  assert.equal(r.result, "再起動後に届いた結果");
  assert.deepEqual(r.history.map((e) => e.type), ["instruction", "result"]);
  assert.equal(n.sent.length, 0); // 即座には完了にしない
  activity.apply(act("idle"), "id-a");
  mgr.onActivity(CAP, "id-a");
  await tick();
  r = mgr.list()[0];
  assert.equal(r.state, "done");
  assert.equal(n.sent.length, 1);
  assert.match(n.sent[0].text, /result: 再起動後に届いた結果/);
  assert.equal(r.server, "id-a"); // 送信元の peer id に更新される
  await sleep(GRACE + POLL * 2); // status 予約が残っていても二重に通知しない
  assert.equal(n.sent.length, 1);
});

test("restore: status が取れない間は failed でなく unknown。取れたら戻って完了を通知する", async () => {
  await seedRunning();
  const n = notifier();
  let down = true;
  const { mgr } = setup({ statusOn: async () => { if (down) throw new Error("broker 未接続"); return statusOf("idle"); } }, undefined, n.notify);
  await mgr.restore();
  await sleep(POLL * 2 + 30);
  assert.equal(mgr.list()[0].state, "unknown");
  assert.match(mgr.list()[0].error ?? "", /broker 未接続/);
  assert.equal(n.sent.length, 0);
  down = false;
  await sleep(GRACE + POLL * 3);
  const r = mgr.list()[0];
  assert.equal(r.state, "done");
  assert.equal(r.error, undefined);
  assert.equal(n.sent.length, 1);
});

test("restore: 再起動後の activity（cap idle・worker 無し）でも追従して完了にできる。running の worker があれば完了にしない", async () => {
  await seedRunning();
  const n = notifier();
  const activity = createActivityStore();
  const { mgr } = setup({ statusOn: async () => statusOf("running") }, activity, n.notify);
  await mgr.restore();
  activity.apply(act("idle", "running"), "id-a");
  mgr.onActivity(CAP, "id-a");
  await tick();
  assert.equal(mgr.list()[0].state, "running");
  activity.apply(act("idle", "done"), "id-a");
  mgr.onActivity(CAP, "id-a");
  await tick();
  assert.equal(mgr.list()[0].state, "done");
  assert.equal(n.sent.length, 1);
});

test("restore: store に保存した unknown / 未完了の指示付き done も追従対象。delete すれば予約は消える", async () => {
  await seedRunning({ state: "done", finishedAt: "2026-11-04T00:00:05.000Z", result: "r" });
  const n = notifier();
  const { mgr } = setup({ statusOn: async () => statusOf("idle") }, undefined, n.notify);
  await mgr.restore();
  await sleep(GRACE + POLL * 2);
  assert.equal(n.sent.length, 1);
  await mgr.delete({});
  assert.equal(mgr.list().length, 0);
});

// -- model / worker_model --

const cfgServers = (s: object[]) => parseConfig({ servers: s }, "/x/c.json").servers;

test("send: model / worker_model の指定（新規の cap）。指定が config より優先され、kick_cap と記録と返り値に出る", async () => {
  const servers = cfgServers([{ name: "s1", peer: "bantou-server", model: "opus", workerModel: "haiku" }]);
  const { mgr, kicks } = setup({}, undefined, undefined, servers);
  const r = await mgr.send({ owner: "pm1", prompt: "go", model: "sonnet", worker_model: "claude-haiku-4-5" });
  assert.deepEqual(r, { remote_id: CAP, server: "id-a", serverName: "bantou-server", state: "running", created: true, model: "sonnet", worker_model: "claude-haiku-4-5" });
  assert.deepEqual(kicks[0].cmd, { cap_id: CAP, prompt: "go", model: "sonnet", worker_model: "claude-haiku-4-5", reason: "remote_send owner=pm1" });
  const rec = mgr.list()[0];
  assert.deepEqual([rec.model, rec.worker_model], ["sonnet", "claude-haiku-4-5"]);
  assert.ok(!("model_ignored" in r));
});

test("send: 新規の cap で片方だけ指定したら、もう片方は config の既定", async () => {
  const servers = cfgServers([{ name: "s1", peer: "bantou-server", model: "opus", workerModel: "haiku" }]);
  const { mgr, kicks } = setup({}, undefined, undefined, servers);
  await mgr.send({ owner: "pm1", prompt: "go", worker_model: "sonnet" });
  assert.deepEqual(kicks[0].cmd, { cap_id: CAP, prompt: "go", model: "opus", worker_model: "sonnet", reason: "remote_send owner=pm1" });
});

test("send: 既存の cap では model を無視して返り値に残す。worker_model は resume の kick_cap に載せて記録を更新（config の既定は載せない）", async () => {
  const servers = cfgServers([{ name: "s1", peer: "bantou-server", model: "opus", workerModel: "haiku" }]);
  const { mgr, kicks } = setup({}, undefined, undefined, servers);
  await mgr.send({ owner: "pm1", prompt: "one" });
  kicks[0].resolve(ok("r1"));
  await tick();
  mgr.onActivity(CAP);
  // 既存の cap: 指定なしなら何も載せない
  const plain = await mgr.send({ owner: "pm1", prompt: "two" });
  assert.deepEqual(kicks[1].cmd, { cap_id: CAP, prompt: "two", reason: "remote_send owner=pm1" });
  assert.ok(!("model_ignored" in plain));
  kicks[1].resolve(ok("r2"));
  await tick();
  // model だけ: 無視（kick_cap に載せない）、返り値で知らせる
  const ign = await mgr.send({ owner: "pm1", prompt: "three", model: "sonnet" });
  assert.equal(ign.created, false);
  assert.equal(ign.model_ignored, true);
  assert.match(ign.note ?? "", /cap は既存なので model は無視した/);
  assert.deepEqual(kicks[2].cmd, { cap_id: CAP, prompt: "three", reason: "remote_send owner=pm1" });
  assert.equal(mgr.list()[0].model, "opus"); // 記録は cap を作った時の値のまま
  kicks[2].resolve(ok("r3"));
  await tick();
  // worker_model: resume の kick_cap に載せ、記録を更新
  const wm = await mgr.send({ owner: "pm1", prompt: "four", model: "sonnet", worker_model: "sonnet" });
  assert.deepEqual(kicks[3].cmd, { cap_id: CAP, prompt: "four", worker_model: "sonnet", reason: "remote_send owner=pm1" });
  assert.deepEqual([wm.worker_model, wm.model_ignored], ["sonnet", true]);
  assert.equal(mgr.list()[0].worker_model, "sonnet");
});

test("send: 形式が不正な model / worker_model は、送らず記録も作らず拒否（protocol の MODEL_PATTERN）", async () => {
  const { mgr, kicks } = setup();
  await assert.rejects(mgr.send({ owner: "o", prompt: "p", model: "a b" }), /model が不正/);
  await assert.rejects(mgr.send({ owner: "o", prompt: "p", worker_model: "-x" }), /worker_model が不正/);
  assert.equal(kicks.length, 0);
  assert.equal(mgr.list().length, 0);
});

test("send: config の servers[] は送信のたびに読み直す（読めない時は直前の値で送り、ログに残す）", async () => {
  const path = join(dir, "config.json");
  const write = (s: object[] | string) => writeFile(path, typeof s === "string" ? s : JSON.stringify({ servers: s }));
  await write([{ name: "s1", peer: "bantou-server", model: "opus", workerModel: "haiku" }]);
  const logs: string[] = [];
  const { mgr, kicks, caps } = setup({}, undefined, undefined, cfgServers([{ name: "s1", peer: "bantou-server", model: "boot-time" }]), { configPath: path, log: (m) => logs.push(m) });
  await mgr.send({ owner: "o", prompt: "a" });
  assert.deepEqual([kicks[0].cmd.model, kicks[0].cmd.worker_model], ["opus", "haiku"]); // 起動時の値ではなく、今の config
  // cap を作り直す（server から消えた）ので、変更した config が次の最初の kick に反映される
  caps.set("id-a", []);
  await write([{ name: "s1", peer: "bantou-server", model: "sonnet" }]);
  await mgr.send({ owner: "o", prompt: "b" });
  assert.deepEqual([kicks[1].cmd.model, kicks[1].cmd.worker_model], ["sonnet", undefined]);
  caps.set("id-a", []);
  await write("{ 壊れた");
  await mgr.send({ owner: "o", prompt: "c" });
  assert.equal(kicks[2].cmd.model, "sonnet"); // 直前に読めた値
  assert.ok(logs.some((l) => /config の読み直しに失敗/.test(l)));
});

test("restore: 旧形式（作業ごとの cap、history 無し）は読み捨てず legacy として一覧に出す。指示・通知・遅れた返信の対象外。delete で止めて消せる", async () => {
  const old = [
    { remote_id: "r-0a1b2c3d4e", owner: "pm1", server: "id-a", serverName: "bantou-server", state: "done", createdAt: "2026-11-03T00:00:00.000Z", finishedAt: "2026-11-03T00:10:00.000Z", result: "old result" },
    { remote_id: "r-9f8e7d6c5b", owner: "pm2", server: "id-a", serverName: "bantou-server", state: "running", createdAt: "2026-11-03T01:00:00.000Z" },
  ];
  await writeFile(join(dir, "remotes.json"), JSON.stringify(old));
  const n = notifier();
  const { mgr, stops, kicks } = setup({}, undefined, n.notify);
  await mgr.restore();
  const list = mgr.list();
  assert.deepEqual(list.map((r) => [r.remote_id, r.legacy, r.state]), [["r-0a1b2c3d4e", true, "done"], ["r-9f8e7d6c5b", true, "failed"]]);
  assert.deepEqual(list[0].owners, ["pm1"]);
  assert.ok(!("owner" in list[0]));
  assert.deepEqual(mgr.list({ owner: "pm2" }).map((r) => r.remote_id), ["r-9f8e7d6c5b"]);
  assert.equal(mgr.applyLateReply({ ...ok("x"), cap_id: "r-0a1b2c3d4e" } as never), false);
  // 新しい指示は旧形式に混ぜず、cap の記録を別に作る
  const r = await mgr.send({ owner: "pm1", prompt: "new" });
  assert.equal(r.remote_id, CAP);
  assert.equal(kicks[0].cmd.cap_id, CAP);
  assert.equal(mgr.list().length, 3);
  // 旧形式の cap も stop_cap して記録を消せる
  const d = await mgr.delete({ remote_id: "r-0a1b2c3d4e" });
  assert.deepEqual(d, { remote_id: "r-0a1b2c3d4e", deleted: true, stopped: true });
  assert.deepEqual(stops.map((s) => (s.cmd as { cap_id: string }).cap_id), ["r-0a1b2c3d4e"]);
  assert.equal(n.sent.length, 0);
  const saved = JSON.parse(await readFile(join(dir, "remotes.json"), "utf8")) as RemoteRecord[];
  assert.deepEqual(saved.map((x) => [x.remote_id, x.legacy ?? false]), [["r-9f8e7d6c5b", true], [CAP, false]]);
});

test("restore: 不正な remote_id の記録は読み飛ばす", async () => {
  await writeFile(join(dir, "remotes.json"), JSON.stringify([{ remote_id: "a b" }, { state: "done" }]));
  const { mgr } = setup();
  await mgr.restore();
  assert.equal(mgr.list().length, 0);
});

// -- cap_id --

test("loadCapId: c-<10 桁 hex>。保存して、再読込（center 再起動）で同じ値になる。不正な内容は作り直す", async () => {
  const logs: string[] = [];
  const a = await loadCapId(dir, (m) => logs.push(m));
  assert.match(a, /^c-[0-9a-f]{10}$/);
  assert.equal(await loadCapId(dir, () => {}), a);
  assert.equal(await loadCapId(dir, () => {}), a);
  await writeFile(join(dir, "center-id"), "zzz\n");
  const b = await loadCapId(dir, (m) => logs.push(m));
  assert.match(b, /^c-[0-9a-f]{10}$/);
  assert.notEqual(b, a);
  assert.equal(await loadCapId(dir, () => {}), b);
  assert.ok(logs.some((m) => /不正/.test(m)));
});

test("loadCapId: dir ごとに別の id（center ごとに固定）。保存できない時はその起動の間だけの id を返し、ログに残す", async () => {
  const other = await mkdtemp(join(tmpdir(), "center-rem2-"));
  try {
    assert.notEqual(await loadCapId(dir, () => {}), await loadCapId(other, () => {}));
  } finally {
    await rm(other, { recursive: true, force: true });
  }
  await writeFile(join(dir, "file"), "x");
  const logs: string[] = [];
  const id = await loadCapId(join(dir, "file", "sub"), (m) => logs.push(m));
  assert.match(id, /^c-[0-9a-f]{10}$/);
  assert.ok(logs.some((m) => /保存できない/.test(m)));
});

test("config: servers[] の model / workerModel は形式を検証する。省略できる", () => {
  const good = parseConfig({ servers: [{ name: "s", model: "opus[1m]", workerModel: "claude-sonnet-5-5" }, { name: "t" }] }, "/x/c.json");
  assert.deepEqual([good.servers[0].model, good.servers[0].workerModel, good.servers[1].model], ["opus[1m]", "claude-sonnet-5-5", undefined]);
  assert.throws(() => parseConfig({ servers: [{ name: "s", model: "-x" }] }, "/x/c.json"), /config が不正/);
  assert.throws(() => parseConfig({ servers: [{ name: "s", workerModel: "a b" }] }, "/x/c.json"), /config が不正/);
});

// 型の確認（RemoteManager の公開面）
const _typecheck = (m: RemoteManager): void => void [m.send, m.delete, m.list, m.wait, m.restore, m.applyLateReply, m.onActivity];
void _typecheck;
