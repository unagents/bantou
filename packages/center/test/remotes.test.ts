import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, mock, test } from "node:test";
import { createActivityStore, type ActivityStore } from "../src/activity.js";
import { createEventHub } from "../src/events.js";
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

const CENTER = "c-0123456789";
/** 既定の session（pm1）の cap_id。 */
const CAP = `${CENTER}-pm1`;
const CAP2 = `${CENTER}-pm2`;
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
    taskOn: (peer: ServerPeer, cmd: Record<string, unknown>) =>
      new Promise((resolve) => {
        kicks.push({ peer, cmd, resolve });
        // server は task で cap を作る（次の status には載る）
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
  const mgr = createRemoteManager({ link, store, log: () => {}, capId: CENTER, graceMs: GRACE, pollMs: POLL, ...(servers ? { servers } : {}), ...(activity ? { activity } : {}), ...(notify ? { notify } : {}), ...extra });
  return { mgr, kicks, stops, store, caps, setPeers: (p: ServerPeer[]) => (peers = p) };
}
/** テストでは猶予・追従間隔を短くする（本番は 15 秒）。 */
const GRACE = 60;
const POLL = 40;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 10));
const ok = (text: string, taskId = "t-late") => ({
  bantou: 1, type: "task_result", cap_id: CAP, task_id: taskId, state: "done", summary: text,
  workers: [], review: { verdict: "unknown", items: [], rounds: 0 }, remaining: [],
});
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

test("send: task を送る（goal のみなら deliverables {} / verify {} / constraints [] / workers {}）。status で cap の有無を確かめ、worker_model は新規の cap だけ config の servers[] から。task_id は center が採番", async () => {
  const servers = parseConfig({ servers: [{ name: "s1", peer: "bantou-server", model: "opus", workerModel: "haiku" }] }, "/x/c.json").servers;
  const { mgr, kicks } = setup({}, undefined, undefined, servers);
  const r = await mgr.send({ owner: "pm1", goal: "go" });
  assert.match(r.task_id, /^[A-Za-z0-9_-]+$/);
  assert.deepEqual(r, { remote_id: CAP, server: "id-a", peer: "id-a", host: "host-a", serverName: "bantou-server", state: "running", created: true, task_id: r.task_id, worker_model: "haiku" });
  assert.equal(kicks.length, 1);
  assert.equal(kicks[0].peer.id, "id-a");
  assert.deepEqual(kicks[0].cmd, { cap_id: CAP, task_id: r.task_id, goal: "go", deliverables: {}, verify: {}, constraints: [], workers: {}, worker_model: "haiku" });
  const saved = JSON.parse(await readFile(join(dir, "remotes.json"), "utf8")) as RemoteRecord[];
  assert.equal(saved.length, 1);
  assert.equal(saved[0].state, "running");
  assert.equal(saved[0].pending[0].task_id, r.task_id);
});

test("send: goal 以外の引数（repo / branch / deliverables / verify / constraints / workers / worker_model）を task にそのまま載せる", async () => {
  const { mgr, kicks } = setup();
  const workers = { items: [{ id: "impl", role: "implement" as const, scope: "実装" }, { role: "review" as const, scope: "確認", depends_on: ["impl"], model: "opus" }] };
  const r = await mgr.send({ owner: "pm1", goal: "g", repo: "https://example.com/r.git", branch: "main", deliverables: { branch: "feature/x", report_path: "docs/r.md", other: ["a"] }, verify: { tests: ["npm test"], steps: ["見る"] }, constraints: ["c1"], workers, worker_model: "sonnet" });
  assert.deepEqual(kicks[0].cmd, { cap_id: CAP, task_id: r.task_id, goal: "g", repo: "https://example.com/r.git", branch: "main", deliverables: { branch: "feature/x", report_path: "docs/r.md", other: ["a"] }, verify: { tests: ["npm test"], steps: ["見る"] }, constraints: ["c1"], workers, worker_model: "sonnet" });
});

test("send: 設定に workerModel が無ければ worker_model は付けない", async () => {
  const { mgr, kicks } = setup();
  const r = await mgr.send({ owner: "pm1", goal: "go" });
  assert.ok(!("worker_model" in r));
  assert.ok(!("worker_model" in kicks[0].cmd));
});

test("send: 2 回目の指示は同じ cap_id の task（task_id は別）。既存の cap なので config の worker_model は付けず、記録は 1 件のまま", async () => {
  const servers = parseConfig({ servers: [{ name: "s1", peer: "bantou-server", workerModel: "haiku" }] }, "/x/c.json").servers;
  const { mgr, kicks } = setup({}, undefined, undefined, servers);
  const first = await mgr.send({ owner: "pm1", goal: "one" });
  kicks[0].resolve(ok("r1", first.task_id));
  await tick();
  const second = await mgr.send({ owner: "pm1", goal: "two" });
  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.notEqual(second.task_id, first.task_id);
  assert.equal(kicks.length, 2);
  assert.deepEqual(kicks[1].cmd, { cap_id: CAP, task_id: second.task_id, goal: "two", deliverables: {}, verify: {}, constraints: [], workers: {} });
  assert.equal(mgr.list().length, 1);
  assert.equal(second.remote_id, first.remote_id);
});

test("renameSession: session と pending の owner を付け替えて保存する。cap_id は変えず、改名後の send は同じ cap_id の既存の cap へ送る", async () => {
  const { mgr, kicks, store, caps } = setup();
  const first = await mgr.send({ owner: "pm1", goal: "one" });
  assert.equal(first.remote_id, CAP);
  assert.equal(await mgr.renameSession("pm1", "pm9"), 1);
  const v = mgr.list();
  assert.equal(v.length, 1);
  assert.equal(v[0].remote_id, CAP);
  assert.equal(v[0].session, "pm9");
  assert.deepEqual(v[0].owners, ["pm9"]);
  assert.deepEqual(mgr.list({ owner: "pm1" }), []);
  assert.equal(mgr.list({ owner: "pm9" }).length, 1);
  const saved = await store.load();
  assert.equal(saved[0].session, "pm9");
  assert.equal(saved[0].pending[0].owner, "pm9");
  kicks[0].resolve(ok("r1", first.task_id));
  await tick();
  const second = await mgr.send({ owner: "pm9", goal: "two" });
  assert.equal(second.remote_id, CAP);
  assert.equal(second.created, false);
  assert.deepEqual(kicks[1].cmd.cap_id, CAP);
  assert.deepEqual(caps.get(peerA.id), [CAP]);
  assert.equal(mgr.list().length, 1);
});

test("renameSession: 他の session の記録・無関係な名前には触れない。該当なしは 0 件", async () => {
  const { mgr, kicks } = setup();
  await mgr.send({ owner: "pm1", goal: "a" });
  await mgr.send({ owner: "pm2", goal: "b" });
  assert.equal(kicks.length, 2);
  assert.equal(await mgr.renameSession("nope", "x"), 0);
  assert.equal(await mgr.renameSession("pm1", "pm3"), 1);
  assert.deepEqual(mgr.list({ owner: "pm2" }).map((x) => x.remote_id), [CAP2]);
  assert.deepEqual(mgr.list({ owner: "pm3" }).map((x) => x.remote_id), [CAP]);
});

test("renameSession: 再起動（同じ store で restore）後も記録は新しい名前のまま、send は旧 cap_id を使い、記録は 1 件", async () => {
  const a = setup();
  const first = await a.mgr.send({ owner: "pm1", goal: "one" });
  a.kicks[0].resolve(ok("r1", first.task_id));
  await tick();
  await a.mgr.renameSession("pm1", "pm9");
  const b = setup({ statusOn: async () => ({ bantou: 1, type: "status_result", ok: true, caps: [{ kind: "cap", id: CAP }], workers: [] }) as never });
  await b.mgr.restore();
  assert.deepEqual(b.mgr.list({ owner: "pm9" }).map((x) => [x.remote_id, x.session]), [[CAP, "pm9"]]);
  assert.deepEqual(b.mgr.list({ owner: "pm1" }), []);
  const second = await b.mgr.send({ owner: "pm9", goal: "two" });
  assert.equal(second.remote_id, CAP);
  assert.equal(second.created, false);
  assert.equal(b.kicks[0].cmd.cap_id, CAP);
  assert.equal(b.mgr.list().length, 1);
});

test("conflictsWith (a): cap_id が c-…-<name> の記録の session が name と違うなら create / rename とも拒否（pm1 → pm9 改名後に pm1 を作る・pm1 へ改名する）。remote_delete で消せば通る", async () => {
  const { mgr } = setup();
  await mgr.send({ owner: "pm1", goal: "a" });
  await mgr.renameSession("pm1", "pm9");
  assert.match(mgr.conflictsWith("pm1", "create")!, new RegExp(`${CAP}.*pm9.*remote_delete`));
  assert.match(mgr.conflictsWith("pm1", "rename")!, /remote_delete/);
  assert.equal(mgr.conflictsWith("other", "create"), null);
  assert.equal(mgr.conflictsWith("other", "rename"), null);
  assert.equal(mgr.conflictsWith("bad name!", "create"), null);
  await mgr.delete({ owner: "pm9", force: true });
  assert.equal(mgr.conflictsWith("pm1", "create"), null);
  assert.equal(mgr.conflictsWith("pm1", "rename"), null);
});

test("conflictsWith: 改名元（oldName）の session が持つ記録は衝突と見なさない。pm1 → pm2 → pm1 が通り、記録の session が pm1 に戻る。create 側は変えない", async () => {
  const { mgr } = setup();
  await mgr.send({ owner: "pm1", goal: "a" });
  await mgr.renameSession("pm1", "pm2");
  // pm2 が旧名 pm1 へ戻す: 記録は改名元 pm2 のもの
  assert.equal(mgr.conflictsWith("pm1", "rename", "pm2"), null);
  // 別の session（pm3）が pm1 へ改名するのは従来どおり拒否。oldName 無しも拒否
  assert.match(mgr.conflictsWith("pm1", "rename", "pm3")!, /remote_delete/);
  assert.match(mgr.conflictsWith("pm1", "rename")!, /remote_delete/);
  // create は変えない
  assert.match(mgr.conflictsWith("pm1", "create")!, /remote_delete/);
  assert.equal(await mgr.renameSession("pm2", "pm1"), 1);
  const v = mgr.list();
  assert.deepEqual(v.map((x) => [x.remote_id, x.session]), [[CAP, "pm1"]]);
  assert.equal(mgr.conflictsWith("pm1", "create"), null);
});

test("conflictsWith (b): session が name の記録（削除済み session の残り）があれば、その名前への改名は拒否", async () => {
  const { mgr } = setup();
  await mgr.send({ owner: "pm1", goal: "a" }); // pm1 は session_delete 済みで記録だけ残る想定
  assert.match(mgr.conflictsWith("pm1", "rename")!, /remote 記録が残っている.*pm1.*remote_delete/);
  assert.equal(mgr.conflictsWith("pm3", "rename"), null);
});

test("conflictsWith: 許す場合 — session_delete 後に同名で session_create（session が name の記録を続きとして引き継ぐ）。send も同じ cap_id", async () => {
  const { mgr, kicks } = setup();
  const first = await mgr.send({ owner: "pm1", goal: "a" });
  assert.equal(mgr.conflictsWith("pm1", "create"), null);
  kicks[0].resolve(ok("r1", first.task_id));
  await tick();
  const second = await mgr.send({ owner: "pm1", goal: "b" });
  assert.equal(second.remote_id, CAP);
  assert.equal(mgr.list().length, 1);
});

test("send: 前の指示の返信を待たずに続けて送っても、同じ cap_id で 2 本とも task になる（記録は 1 件）", async () => {
  const { mgr, kicks } = setup();
  await mgr.send({ owner: "pm1", goal: "one" });
  const second = await mgr.send({ owner: "pm1", goal: "two" });
  assert.equal(second.created, false);
  assert.deepEqual(kicks.map((k) => [k.cmd.cap_id, k.cmd.goal]), [[CAP, "one"], [CAP, "two"]]);
  assert.equal(mgr.list().length, 1);
  assert.equal(mgr.list()[0].state, "running");
});

test("send: 同時に 2 本送っても最初の kick_cap は 1 本だけ（server ごとに直列）", async () => {
  const { mgr, kicks } = setup();
  const [a, b] = await Promise.all([mgr.send({ owner: "pm1", goal: "a" }), mgr.send({ owner: "pm1", goal: "b" })]);
  assert.deepEqual([a.created, b.created].sort(), [false, true]);
  assert.equal(kicks.length, 2);
  assert.equal(mgr.list().length, 1);
});

test("send: server に cap があるのに center の記録が無い時は、記録を作って worker_model なしで送る", async () => {
  const servers = parseConfig({ servers: [{ name: "s1", peer: "bantou-server", workerModel: "haiku" }] }, "/x/c.json").servers;
  const { mgr, kicks, caps } = setup({}, undefined, undefined, servers);
  caps.set("id-a", [CAP]);
  const r = await mgr.send({ owner: "pm1", goal: "go" });
  assert.equal(r.created, false);
  assert.ok(!("worker_model" in kicks[0].cmd));
  assert.equal(mgr.list().length, 1);
});

test("send: server に cap が無くなっていれば、記録があっても新規の cap として config の worker_model を付けて送る", async () => {
  const servers = parseConfig({ servers: [{ name: "s1", peer: "bantou-server", workerModel: "haiku" }] }, "/x/c.json").servers;
  const { mgr, kicks, caps } = setup({}, undefined, undefined, servers);
  await mgr.send({ owner: "pm1", goal: "one" });
  kicks[0].resolve(ok("r1"));
  await tick();
  caps.clear();
  const r = await mgr.send({ owner: "pm1", goal: "two" });
  assert.equal(r.created, true);
  assert.equal(kicks[1].cmd.worker_model, "haiku");
  assert.equal(mgr.list().length, 1);
});

test("send: status が error なら cap の有無が分からないので送らず、記録も作らない", async () => {
  const { mgr, kicks } = setup({ statusOn: async () => ({ bantou: 1, type: "error", ok: false, message: "タイムアウト", command: "status" }) as never });
  await assert.rejects(mgr.send({ owner: "pm1", goal: "p" }), /cap を確かめられない: タイムアウト/);
  assert.equal(kicks.length, 0);
  assert.equal(mgr.list().length, 0);
});

test("send: server は peer id か名前で指定でき、server ごとに記録（cap）が 1 件。見つからなければ記録を作らず失敗", async () => {
  const { mgr, kicks } = setup();
  assert.equal((await mgr.send({ owner: "pm1", goal: "p", server: "id-b" })).serverName, "other");
  assert.equal((await mgr.send({ owner: "pm1", goal: "p", server: "bantou-server" })).server, "id-a");
  await assert.rejects(mgr.send({ owner: "pm1", goal: "p", server: "zzz" }), /見つからない/);
  assert.equal(mgr.list().length, 2);
  assert.equal(kicks.length, 2);
  assert.equal(kicks[0].cmd.cap_id, kicks[1].cmd.cap_id);
});

test("send: owner 形式が不正なら拒否", async () => {
  const { mgr } = setup();
  await assert.rejects(mgr.send({ owner: "a b", goal: "p" }), /owner/);
});

test("send: 門が断る（protocol の版違い・更新待ち）時は投げ、記録も kick_cap も作らない", async () => {
  const { mgr, kicks } = setup({ gate: () => ({ bantou: 1, type: "error", ok: false, message: "更新待ち", code: "updating", retryable: true }) } as never);
  await assert.rejects(mgr.send({ owner: "pm1", goal: "p" }), /更新待ち/);
  assert.equal(mgr.list().length, 0);
  assert.equal(kicks.length, 0);
});

test("schema: remote_send / remote_create は goal 必須。deliverables / verify / constraints / workers / repo / branch / server / worker_model を受け、model は受けない。worker_model は protocol と同じ形式で検証", () => {
  assert.equal(remoteCreateSchema, remoteSendSchema);
  const s = z.object(remoteSendSchema);
  assert.deepEqual(s.parse({ goal: "x", server: "s", model: "opus", repo: "r", branch: "b", worker_model: "haiku" }), { goal: "x", server: "s", repo: "r", branch: "b", worker_model: "haiku" });
  const full = { goal: "x", deliverables: { branch: "f", report_path: "p", other: ["o"] }, verify: { tests: ["t"], steps: ["s"] }, constraints: ["c"], workers: { items: [{ id: "a-1", role: "docs", scope: "s", model: "opus", depends_on: ["b"] }] } };
  assert.deepEqual(s.parse(full), full);
  assert.deepEqual(s.parse({ goal: "x", worker_model: "claude-opus-4-8[1m]" }), { goal: "x", worker_model: "claude-opus-4-8[1m]" });
  for (const bad of ["a b", "-x", "a;b", ""]) assert.ok(!s.safeParse({ goal: "x", worker_model: bad }).success, `worker_model=${bad}`);
  assert.ok(!s.safeParse({ prompt: "x" }).success);
  assert.ok(!s.safeParse({ goal: "" }).success);
  assert.ok(!s.safeParse({ goal: "a\0b" }).success);
  assert.ok(!s.safeParse({ goal: "x", branch: "-x" }).success);
  assert.ok(!s.safeParse({ goal: "x", deliverables: { branch: "-x" } }).success);
  assert.ok(!s.safeParse({ goal: "x", workers: { items: [{ role: "boss", scope: "s" }] } }).success);
  assert.ok(!s.safeParse({ goal: "x", workers: { items: [{ role: "test", scope: "" }] } }).success);
  assert.ok(!s.safeParse({ goal: "x", constraints: ["a\0b"] }).success);
});

// -- 返信・履歴 --

test("返信で state が done / failed に更新され、最新の result / error と時刻だけを持つ（履歴は無い）", async () => {
  const { mgr, kicks } = setup();
  await mgr.send({ owner: "pm1", goal: "one" });
  kicks[0].resolve(ok("OK!"));
  await tick();
  mgr.onActivity(CAP);
  await tick();
  let r = mgr.list()[0];
  assert.equal(r.state, "done");
  assert.equal(r.result, "OK!");
  assert.ok(r.finishedAt);
  assert.ok(r.result_at);
  assert.equal(r.error_at, undefined);
  await mgr.send({ owner: "pm1", goal: "two" });
  kicks[1].resolve({ bantou: 1, type: "error", ok: false, message: "boom", command: "task", cap_id: CAP });
  await tick();
  mgr.onActivity(CAP);
  await tick();
  r = mgr.list()[0];
  assert.deepEqual([r.state, r.error, r.result], ["failed", "boom", "OK!"]);
  assert.ok(r.error_at);
  assert.equal(r.result_at !== undefined, true);
  assert.equal("history" in r, false);
  assert.deepEqual(r.pending, []);
  assert.deepEqual(r.owners, []);
});

test("remote_list の形: server ごとに 1 件。state・最新の result / error と時刻・pending・owners・worker_reports だけ（history・legacy は無い）", async () => {
  const { mgr, kicks } = setup();
  await mgr.send({ owner: "pm1", goal: "one" });
  const [r] = mgr.list();
  assert.deepEqual(Object.keys(r).sort(), ["createdAt", "owners", "peer", "peer_seen_at", "pending", "remote_id", "server", "serverHost", "serverName", "server_label", "session", "state", "worker_reports"]);
  assert.deepEqual(r.owners, ["pm1"]);
  kicks[0].resolve(ok("R"));
  await tick();
  mgr.onActivity(CAP);
  await tick();
  const [d] = mgr.list();
  assert.deepEqual(Object.keys(d).sort(), ["createdAt", "finishedAt", "owners", "peer", "peer_seen_at", "pending", "remote_id", "result", "result_at", "server", "serverHost", "serverName", "server_label", "session", "state", "task_result", "worker_reports"]);
  assert.deepEqual([d.state, d.result, d.pending], ["done", "R", []]);
});

test("未完了の指示の prompt は goal の先頭 200 文字だけ。task には全文。通知先 owner と時刻を持つ", async () => {
  const { mgr, kicks } = setup();
  const long = "x".repeat(500);
  await mgr.send({ owner: "pm1", goal: long });
  const p = mgr.list()[0].pending[0];
  assert.equal(p.prompt.length, 200);
  assert.deepEqual([p.owner, typeof p.at], ["pm1", "string"]);
  assert.equal(kicks[0].cmd.goal, long);
});

test("送信自体の失敗（server に届かない reject）は failed でなく unknown。status が取れたら戻り、完了を通知する", async () => {
  const n = notifier();
  let down = false;
  const { mgr } = setup({ taskOn: async () => { throw new Error("link down"); }, statusOn: async () => { if (down) throw new Error("no peer"); return { bantou: 1, type: "status_result", ok: true, caps: [{ kind: "cap", id: CAP, state: "idle" }], workers: [] } as never; } }, undefined, n.notify);
  await mgr.send({ owner: "pm1", goal: "p" });
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
  await mgr.send({ owner: "pm1", goal: "p" });
  kicks[0].resolve({ bantou: 1, type: "error", ok: false, message: "updating", command: "task", cap_id: CAP });
  await tick();
  assert.equal(mgr.list()[0].state, "failed");
});

test("list: owner はその owner の未完了の指示がある cap だけ。返り値の変更は内部に影響しない", async () => {
  const { mgr } = setup();
  await mgr.send({ owner: "pm1", goal: "p" });
  await mgr.send({ owner: "b", goal: "p", server: "id-b" });
  assert.deepEqual(mgr.list({ owner: "pm1" }).map((r) => r.server), ["id-a"]);
  assert.deepEqual(mgr.list({ owner: "b" }).map((r) => r.server), ["id-b"]);
  assert.equal(mgr.list().length, 2);
  mgr.list()[0].state = "done";
  mgr.list()[0].pending.length = 0;
  assert.equal(mgr.list()[0].state, "running");
  assert.equal(mgr.list()[0].pending.length, 1);
});

test("完了した指示は消える。件数が増えても記録は 1 件・pending は未完了だけ", async () => {
  const { mgr, kicks } = setup();
  for (let i = 0; i < 30; i++) {
    await mgr.send({ owner: "pm1", goal: `p${i}` });
    kicks[i].resolve(ok(`r${i}`));
    await tick();
    mgr.onActivity(CAP);
    await tick();
    assert.deepEqual(mgr.list()[0].pending, []);
  }
  assert.equal(mgr.list().length, 1);
  assert.equal(mgr.list()[0].result, "r29");
});

// -- 完了判定と通知 --

test("通知: 指示を送った session へ、cap が idle で worker 無しになった時に 1 回。指示の先頭・state・result を含む", async () => {
  const n = notifier();
  const { mgr, kicks } = setup({}, undefined, n.notify);
  await mgr.send({ owner: "pm1", goal: "調べて" });
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
  assert.deepEqual(mgr.list()[0].pending, []); // 完了したら消える
  // 同じ結果の再受信・activity の繰り返しでは送り直さない
  mgr.applyLateReply(lateOk("調査結果"));
  mgr.onActivity(CAP);
  await tick();
  assert.equal(n.sent.length, 1);
});

test("通知: failed（error 返信）も error 付きで送る", async () => {
  const n = notifier();
  const { mgr, kicks } = setup({}, undefined, n.notify);
  await mgr.send({ owner: "pm1", goal: "p" });
  kicks[0].resolve({ bantou: 1, type: "error", ok: false, message: "updating", command: "task", cap_id: CAP });
  await tick();
  assert.match(n.sent[0].text, /state=failed/);
  assert.match(n.sent[0].text, /error: updating/);
});

test("通知: 同じ session の指示が重なっても、cap が idle になるまで送らず、idle になった時に未完了を全て完了にして 1 回。他 session の cap は別", async () => {
  const n = notifier();
  const { mgr, kicks } = setup({}, undefined, n.notify);
  await mgr.send({ owner: "pm1", goal: "A" });
  await mgr.send({ owner: "pm2", goal: "B" });
  await mgr.send({ owner: "pm1", goal: "C" });
  // pm1 の 1 本目の返信: 後ろに返信待ちの指示がある間は完了にしない
  kicks[0].resolve(ok("r-A"));
  await tick();
  mgr.onActivity(CAP);
  await tick();
  assert.equal(n.sent.length, 0);
  assert.equal(mgr.list({ owner: "pm1" })[0].state, "running");
  // pm2 の cap は pm1 と独立。pm2 にだけ通知が行く
  kicks[1].resolve(ok("r-B"));
  await tick();
  mgr.onActivity(CAP2);
  await tick();
  assert.deepEqual(n.sent.map((s) => s.owner), ["pm2"]);
  assert.match(n.sent[0].text, new RegExp(`remote_id=${CAP2}`));
  assert.match(n.sent[0].text, /指示: B/);
  // pm1 の最後の返信で、2 本とも完了。1 通
  kicks[2].resolve(ok("r-C"));
  await tick();
  mgr.onActivity(CAP);
  await tick();
  assert.deepEqual(n.sent.map((s) => s.owner), ["pm2", "pm1"]);
  assert.match(n.sent[1].text, /指示: A \/ C/);
  assert.match(n.sent[1].text, /result: r-C/);
  assert.deepEqual(mgr.list({ owner: "pm1" })[0].pending, []);
});

test("通知: 通知先は cap の session だけ（別 session の cap の完了は届かない）。完了後の新しい指示は新しい通知", async () => {
  const n = notifier();
  const { mgr, kicks } = setup({}, undefined, n.notify);
  await mgr.send({ owner: "pm1", goal: "A" });
  kicks[0].resolve(ok("rA"));
  await tick();
  mgr.onActivity(CAP);
  await tick();
  assert.deepEqual(n.sent.map((s) => s.owner), ["pm1"]);
  await mgr.send({ owner: "pm2", goal: "B" });
  kicks[1].resolve(ok("rB"));
  await tick();
  mgr.onActivity(CAP2);
  await tick();
  assert.deepEqual(n.sent.map((s) => s.owner), ["pm1", "pm2"]);
  assert.match(n.sent[1].text, /result: rB/);
  assert.doesNotMatch(n.sent[1].text, /指示: .*A/);
  await mgr.send({ owner: "pm1", goal: "A2" });
  kicks[2].resolve(ok("rA2"));
  await tick();
  mgr.onActivity(CAP);
  await tick();
  assert.deepEqual(n.sent.map((s) => s.owner), ["pm1", "pm2", "pm1"]);
});

test("通知: worker が running / stalled の間は送らず、全部終わった activity 通知で 1 回だけ送る", async () => {
  const n = notifier();
  const activity = createActivityStore();
  const { mgr, kicks } = setup({}, activity, n.notify);
  await mgr.send({ owner: "pm1", goal: "p" });
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
  await mgr.send({ owner: "pm1", goal: "p" });
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

test("通知: 送れなくても指示は消え、再送しない", async () => {
  const n = notifier("peer がいない");
  const { mgr, kicks } = setup({}, undefined, n.notify);
  await mgr.send({ owner: "pm1", goal: "p" });
  kicks[0].resolve(ok("r"));
  await tick();
  mgr.onActivity(CAP);
  await tick();
  assert.deepEqual(mgr.list()[0].pending, []);
  mgr.onActivity(CAP);
  await tick();
  assert.equal(n.sent.length, 1);
});

test("通知: notify が throw しても落ちない。notify 無しでも指示は消える", async () => {
  const { mgr, kicks } = setup({}, undefined, (async () => { throw new Error("push 失敗"); }) as Notify);
  await mgr.send({ owner: "pm1", goal: "p" });
  kicks[0].resolve(ok("r"));
  await tick();
  mgr.onActivity(CAP);
  await tick();
  assert.deepEqual(mgr.list()[0].pending, []);
  const b = setup();
  await b.mgr.send({ owner: "pm1", goal: "p" });
  b.kicks[0].resolve(ok("r"));
  await tick();
  b.mgr.onActivity(CAP);
  await tick();
  assert.deepEqual(b.mgr.list()[0].pending, []);
});

// -- applyLateReply --

test("applyLateReply: 最初の返信の後の cap_result で result が最新になる。失敗なら failed、次の成功で done に戻る", async () => {
  const { mgr, kicks } = setup();
  await mgr.send({ owner: "pm1", goal: "p" });
  kicks[0].resolve(ok("first"));
  await tick();
  mgr.onActivity(CAP);
  await tick();
  assert.equal(mgr.applyLateReply(lateOk("second")), true);
  assert.equal(mgr.list()[0].result, "second");
  assert.equal(mgr.applyLateReply({ ...ok("partial"), state: "failed", error: "kill" } as never), true);
  let r = mgr.list()[0];
  assert.deepEqual([r.state, r.error, r.result], ["failed", "kill", "partial"]);
  mgr.applyLateReply(lateOk("third"));
  r = mgr.list()[0];
  assert.deepEqual([r.state, r.error, r.result], ["done", undefined, "third"]);
});

test("applyLateReply: kick_cap の error は failed + error。結果本文は残す", async () => {
  const { mgr, kicks } = setup();
  await mgr.send({ owner: "pm1", goal: "p" });
  kicks[0].resolve(ok("keep"));
  await tick();
  mgr.onActivity(CAP);
  await tick();
  mgr.applyLateReply({ bantou: 1, type: "error", ok: false, message: "resume 失敗", command: "task", cap_id: CAP });
  const r = mgr.list()[0];
  assert.deepEqual([r.state, r.error, r.result], ["failed", "resume 失敗", "keep"]);
});

test("applyLateReply: 記録なし・返信待ちの指示がある間・delete 済み・cap_id 違いは無視", async () => {
  const { mgr, kicks } = setup();
  assert.equal(mgr.applyLateReply(lateOk("x")), false);
  await mgr.send({ owner: "pm1", goal: "p" });
  // 返信待ちの task と同じ task_id の task_result は待ちに照合されるので触らない
  assert.equal(mgr.applyLateReply(ok("x", kicks[0].cmd.task_id as string) as never), false);
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
  await mgr.send({ owner: "pm1", goal: "a" });
  await mgr.send({ owner: "pm1", goal: "b", server: "id-b" });
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
  await mgr.send({ owner: "pm1", goal: "p" });
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
  mgr.applyLateReply({ bantou: 1, type: "error", ok: false, message: "x", command: "task", cap_id: CAP });
  activity.apply(act("idle", "running"), "id-a");
  assert.equal(mgr.list()[0].state, "failed");
});

test("list: activity 通知のある cap には activity が付き、delete で忘れる。store が無ければ activity キーは付かない", async () => {
  let now = 1_000_000;
  const activity = createActivityStore({ now: () => now });
  const { mgr } = setup({}, activity);
  await mgr.send({ owner: "pm1", goal: "p" });
  activity.apply(act("running"), "id-a");
  now += 2000;
  const r = mgr.list()[0];
  assert.equal(r.activity?.received_ms_ago, 2000);
  assert.equal(r.activity?.agents[0].id, CAP);
  await mgr.delete({ force: true });
  assert.equal(activity.get(CAP, "id-a"), undefined);
  const b = setup();
  await b.mgr.send({ owner: "pm1", goal: "p" });
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
  await mgr.send({ owner: "pm1", goal: "p" });
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
  await mgr.send({ owner: "pm1", goal: "p" });
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
  await mgr.send({ owner: "pm1", goal: "p" });
  await assert.rejects(mgr.wait({ owner: "pm2" }), /running の remote が無い/);
  await assert.rejects(mgr.wait({}), /owner/);
  await assert.rejects(mgr.wait({ remote_id: "zzz" }), /未定義/);
  kicks[0].resolve(ok("x"));
  await tick();
  mgr.onActivity(CAP);
  await tick();
  await assert.rejects(mgr.wait({ owner: "pm1" }), /running の remote が無い/);
  assert.equal((await mgr.wait({ remote_id: CAP, owner: "pm1" })).state, "done");
  // 他の session の cap は remote_id を指定しても見えない（owner 無し = desktop の center_call は全件）
  await assert.rejects(mgr.wait({ remote_id: CAP, owner: "pm2" }), /未定義/);
  assert.equal((await mgr.wait({ remote_id: CAP })).state, "done");
});

test("remote_wait: 複数 server に同じ remote_id がある時は server で絞る", async () => {
  const { mgr, kicks } = setup();
  await mgr.send({ owner: "pm1", goal: "a" });
  await mgr.send({ owner: "pm1", goal: "b", server: "id-b" });
  kicks[1].resolve(ok("B"));
  await tick();
  await assert.rejects(mgr.wait({ remote_id: CAP, timeoutSec: 1 }), /複数の server/);
  assert.equal((await mgr.wait({ remote_id: CAP, server: "id-b", timeoutSec: 1 })).serverName, "other");
  const t = await mgr.wait({ server: "id-a", timeoutSec: 1 });
  assert.equal(t.state, "running");
});

test("remote_wait: timeout なら state=running のまま返す。待ち中の delete は error", async () => {
  const { mgr } = setup();
  await mgr.send({ owner: "pm1", goal: "p" });
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
  await mgr.send({ owner: "pm1", goal: "p" });
  const r = await mgr.delete({ remote_id: CAP });
  assert.deepEqual(r, { remote_id: CAP, deleted: true, stopped: true });
  assert.deepEqual(stops.map((s) => [s.peer.id, s.cmd]), [["id-a", { cap_id: CAP }]]);
  assert.equal(mgr.list().length, 0);
  kicks[0].resolve({ ...ok(""), state: "failed", error: "stop_cap により停止" });
  await tick();
  assert.equal(mgr.list().length, 0);
  assert.deepEqual(JSON.parse(await readFile(join(dir, "remotes.json"), "utf8")), []);
  // 消した後の指示は最初の kick_cap からやり直す
  assert.equal((await mgr.send({ owner: "pm1", goal: "again" })).created, true);
});

test("remote_delete: remote_id 省略は center の cap。未定義は拒否。どの session からでも消せる（owner を見ない）", async () => {
  const { mgr } = setup();
  await assert.rejects(mgr.delete({}), /未定義の remote/);
  await mgr.send({ owner: "pm1", goal: "p" });
  await assert.rejects(mgr.delete({ remote_id: "zzz" }), /未定義/);
  assert.equal((await mgr.delete({})).deleted, true);
});

test("remote_delete: 複数 server にある時は server で指定する", async () => {
  const { mgr, stops } = setup();
  await mgr.send({ owner: "pm1", goal: "p" });
  await mgr.send({ owner: "pm1", goal: "p", server: "id-b" });
  await assert.rejects(mgr.delete({}), /複数の server/);
  await mgr.delete({ server: "id-b" });
  assert.deepEqual(stops.map((s) => s.peer.id), ["id-b"]);
  assert.deepEqual(mgr.list().map((r) => r.server), ["id-a"]);
});

test("remote_delete: server の peer id が変わっていても名前 + host で探して stop を送る。居なければ running は拒否、force で記録だけ消す", async () => {
  const { mgr, stops, setPeers } = setup();
  await mgr.send({ owner: "pm1", goal: "p" });
  setPeers([{ id: "id-a2", name: "bantou-server", hostname: "host-a" }, peerB]);
  await mgr.delete({});
  assert.equal(stops[0].peer.id, "id-a2");
  await mgr.send({ owner: "pm1", goal: "p" });
  setPeers([peerB]);
  await assert.rejects(mgr.delete({}), /止められない/);
  assert.equal(mgr.list().length, 1);
  const r = await mgr.delete({ force: true });
  assert.match(r.warning ?? "", /stop_cap を送れなかった/);
  assert.equal(mgr.list().length, 0);
});

test("remote_delete: stop が error 返信なら running は拒否。終わった記録は警告付きで消せる", async () => {
  const { mgr, kicks } = setup({ stopCapOn: async () => ({ bantou: 1, type: "error", ok: false, message: "kill 失敗", command: "stop_cap" }) as never });
  await mgr.send({ owner: "pm1", goal: "p" });
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
  await mgr.send({ owner: "pm1", goal: "p" });
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
  await mgr.send({ owner: "pm1", goal: "p" });
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
  await mgr.send({ owner: "pm1", goal: "p" }); // status 1 回目（send の cap 確認）
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
  await mgr.send({ owner: "pm1", goal: "p" });
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
  await mgr.send({ owner: "pm1", goal: "p" });
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
  const { mgr } = setup({ taskOn: async () => { throw new Error("link down"); }, statusOn: async () => { if (down) throw new Error("no peer"); return statusOf("idle"); } });
  await mgr.send({ owner: "pm1", goal: "p" });
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
    pending: [{ at: "2026-11-04T00:00:01.000Z", owner: "pm1", prompt: "再起動をまたぐ指示" }], ...extra,
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
  assert.equal(r.pending.length, 1);
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

test("restore: 再起動後に届く cap_result（onLateCapReply）は最新 result に反映し、完了になれば owner へ通知する", async () => {
  await seedRunning();
  const n = notifier();
  const activity = createActivityStore();
  const { mgr } = setup({ statusOn: async () => statusOf("idle") }, activity, n.notify);
  await mgr.restore();
  assert.equal(mgr.applyLateReply(lateOk("再起動後に届いた結果"), "id-a"), true);
  let r = mgr.list()[0];
  assert.equal(r.result, "再起動後に届いた結果");
  assert.equal(r.pending.length, 1);
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

test("send: worker_model の指定（新規の cap）。指定が config より優先され、task と記録と返り値に出る", async () => {
  const servers = cfgServers([{ name: "s1", peer: "bantou-server", model: "opus", workerModel: "haiku" }]);
  const { mgr, kicks } = setup({}, undefined, undefined, servers);
  const r = await mgr.send({ owner: "pm1", goal: "go", worker_model: "claude-haiku-4-5" });
  assert.deepEqual(r, { remote_id: CAP, server: "id-a", peer: "id-a", host: "host-a", serverName: "bantou-server", state: "running", created: true, task_id: r.task_id, worker_model: "claude-haiku-4-5" });
  assert.equal(kicks[0].cmd.worker_model, "claude-haiku-4-5");
  assert.equal(mgr.list()[0].worker_model, "claude-haiku-4-5");
});

test("send: 新規の cap で worker_model を省けば config の既定", async () => {
  const servers = cfgServers([{ name: "s1", peer: "bantou-server", model: "opus", workerModel: "haiku" }]);
  const { mgr, kicks } = setup({}, undefined, undefined, servers);
  await mgr.send({ owner: "pm1", goal: "go" });
  assert.equal(kicks[0].cmd.worker_model, "haiku");
});

test("send: 既存の cap では worker_model は指定された時だけ task に載せて記録を更新（config の既定は載せない）", async () => {
  const servers = cfgServers([{ name: "s1", peer: "bantou-server", workerModel: "haiku" }]);
  const { mgr, kicks } = setup({}, undefined, undefined, servers);
  await mgr.send({ owner: "pm1", goal: "one" });
  kicks[0].resolve(ok("r1"));
  await tick();
  mgr.onActivity(CAP);
  await mgr.send({ owner: "pm1", goal: "two" });
  assert.ok(!("worker_model" in kicks[1].cmd));
  kicks[1].resolve(ok("r2"));
  await tick();
  const wm = await mgr.send({ owner: "pm1", goal: "three", worker_model: "sonnet" });
  assert.equal(kicks[2].cmd.worker_model, "sonnet");
  assert.equal(wm.worker_model, "sonnet");
  assert.equal(mgr.list()[0].worker_model, "sonnet");
});

test("send: 形式が不正な worker_model は、送らず記録も作らず拒否（protocol の MODEL_PATTERN）", async () => {
  const { mgr, kicks } = setup();
  await assert.rejects(mgr.send({ owner: "pm1", goal: "p", worker_model: "-x" }), /worker_model が不正/);
  assert.equal(kicks.length, 0);
  assert.equal(mgr.list().length, 0);
});

test("send: config の servers[] は送信のたびに読み直す（読めない時は直前の値で送り、ログに残す）", async () => {
  const path = join(dir, "config.json");
  const write = (s: object[] | string) => writeFile(path, typeof s === "string" ? s : JSON.stringify({ servers: s }));
  await write([{ name: "s1", peer: "bantou-server", workerModel: "haiku" }]);
  const logs: string[] = [];
  const { mgr, kicks, caps } = setup({}, undefined, undefined, cfgServers([{ name: "s1", peer: "bantou-server", workerModel: "boot-time" }]), { configPath: path, log: (m) => logs.push(m) });
  await mgr.send({ owner: "pm1", goal: "a" });
  assert.equal(kicks[0].cmd.worker_model, "haiku"); // 起動時の値ではなく、今の config
  // cap を作り直す（server から消えた）ので、変更した config が次の最初の task に反映される
  caps.set("id-a", []);
  await write([{ name: "s1", peer: "bantou-server", workerModel: "sonnet" }]);
  await mgr.send({ owner: "pm1", goal: "b" });
  assert.equal(kicks[1].cmd.worker_model, "sonnet");
  caps.set("id-a", []);
  await write("{ 壊れた");
  await mgr.send({ owner: "pm1", goal: "c" });
  assert.equal(kicks[2].cmd.worker_model, "sonnet"); // 直前に読めた値
  assert.ok(logs.some((l) => /config の読み直しに失敗/.test(l)));
});

const legacyRec = (id: string, over: Record<string, unknown> = {}) => ({ remote_id: id, owner: "pm1", server: "id-a", serverName: "bantou-server", serverHost: "host-a", state: "done", createdAt: "2026-11-03T00:00:00.000Z", ...over });

test("restore: 旧形式の記録は、session 無しの旧共有 cap として引き継ぐ（cap_id はそのまま。stop_cap は送らない）。次の指示は session の cap_id へ行き、旧共有 cap には送らない", async () => {
  const old = legacyRec("r-0a1b2c3d4e", { finishedAt: "2026-11-03T00:10:00.000Z", result: "old result", legacy: true, history: [] });
  await writeFile(join(dir, "remotes.json"), JSON.stringify([old]));
  const logs: string[] = [];
  const { mgr, stops, kicks, caps } = setup({}, undefined, undefined, undefined, { log: (m: string) => logs.push(m) });
  caps.set("id-a", ["r-0a1b2c3d4e"]);
  await mgr.restore();
  const v = mgr.list();
  assert.deepEqual(v.map((r) => [r.remote_id, r.server, r.state, r.result]), [["r-0a1b2c3d4e", "id-a", "done", "old result"]]);
  for (const k of ["owner", "legacy", "history"]) assert.equal(k in v[0], false, k);
  assert.deepEqual(v[0].pending, []);
  assert.equal(stops.length, 0);
  assert.equal("session" in v[0], false);
  assert.ok(logs.some((l) => /旧共有 cap（session 無し）として引き継ぐ.*r-0a1b2c3d4e/.test(l)));
  assert.deepEqual((JSON.parse(await readFile(join(dir, "remotes.json"), "utf8")) as RemoteRecord[]).map((r) => r.remote_id), ["r-0a1b2c3d4e"]);
  // 次の指示は session の cap_id（旧共有 cap の cap_id ではない）。旧共有 cap の記録はそのまま
  const r = await mgr.send({ owner: "pm1", goal: "next" });
  assert.equal(r.remote_id, CAP);
  assert.equal(r.created, true);
  assert.equal(kicks[0].cmd.cap_id, CAP);
  assert.deepEqual(mgr.list().map((x) => [x.remote_id, x.session]), [["r-0a1b2c3d4e", undefined], [CAP, "pm1"]]);
  assert.deepEqual(mgr.list({ owner: "pm1" }).map((x) => x.remote_id), [CAP]);
});

test("restore: 同じ server に旧形式が複数あれば最新の 1 件を残し、他は stop_cap を送って記録を消す。別の server の記録は別に残る", async () => {
  const old = [
    legacyRec("r-0a1b2c3d4e", { finishedAt: "2026-11-03T00:10:00.000Z", result: "oldest" }),
    legacyRec("r-9f8e7d6c5b", { state: "running", createdAt: "2026-11-03T05:00:00.000Z", result: "newest" }),
    legacyRec("r-5a5a5a5a5a", { state: "failed", createdAt: "2026-11-03T02:00:00.000Z", legacy: true, history: [] }),
    legacyRec("r-b-only", { server: "id-b", serverName: "other", serverHost: "host-b", result: "b" }),
  ];
  await writeFile(join(dir, "remotes.json"), JSON.stringify(old));
  const logs: string[] = [];
  const n = notifier();
  const { mgr, stops, kicks } = setup({}, undefined, n.notify, undefined, { log: (m: string) => logs.push(m) });
  await mgr.restore();
  assert.deepEqual(mgr.list().map((r) => r.remote_id).sort(), ["r-9f8e7d6c5b", "r-b-only"]);
  assert.deepEqual(stops.map((x) => [x.peer.id, (x.cmd as { cap_id: string }).cap_id]).sort(), [["id-a", "r-0a1b2c3d4e"], ["id-a", "r-5a5a5a5a5a"]]);
  assert.equal(logs.filter((l) => /旧形式の remote を掃除/.test(l)).length, 2);
  assert.equal(mgr.applyLateReply({ ...ok("x"), cap_id: "r-0a1b2c3d4e" } as never), false);
  assert.equal(kicks.length, 0);
  assert.deepEqual((JSON.parse(await readFile(join(dir, "remotes.json"), "utf8")) as RemoteRecord[]).map((r) => r.remote_id).sort(), ["r-9f8e7d6c5b", "r-b-only"]);
});

test("restore: 同じ server に新形式の記録（center の cap_id）と旧形式があっても、形式を問わず最新の 1 件を残す。stop_cap が届かなくても記録は消える", async () => {
  const own: RemoteRecord = { remote_id: CAP, server: "id-a", serverName: "bantou-server", serverHost: "host-a", state: "done", createdAt: "2026-11-04T00:00:00.000Z", result: "own", pending: [] };
  const newer = legacyRec("r-0a1b2c3d4e", { createdAt: "2026-11-05T00:00:00.000Z", result: "newer legacy" });
  await writeFile(join(dir, "remotes.json"), JSON.stringify([own, newer]));
  const logs: string[] = [];
  const { mgr } = setup({ stopCapOn: async () => { throw new Error("link down"); } }, undefined, undefined, undefined, { log: (m: string) => logs.push(m) });
  await mgr.restore();
  assert.deepEqual(mgr.list().map((r) => [r.remote_id, r.result]), [["r-0a1b2c3d4e", "newer legacy"]]);
  assert.ok(logs.some((l) => new RegExp(`stop_cap が届かない.*${CAP}.*link down`).test(l)));
  assert.deepEqual((JSON.parse(await readFile(join(dir, "remotes.json"), "utf8")) as RemoteRecord[]).map((x) => x.remote_id), ["r-0a1b2c3d4e"]);
  await tick(); // 1 つ目の manager の announce（保存を伴う）が済んでから、次の内容を書く
  // 新形式の方が新しければ、新形式が残る（center の cap_id のまま）
  await writeFile(join(dir, "remotes.json"), JSON.stringify([{ ...own, createdAt: "2026-11-06T00:00:00.000Z" }, legacyRec("r-0a1b2c3d4e")]));
  const { mgr: m2, stops } = setup({}, undefined, undefined, undefined, { log: () => {} });
  await m2.restore();
  assert.deepEqual(m2.list().map((r) => r.remote_id), [CAP]);
  assert.deepEqual(stops.map((x) => (x.cmd as { cap_id: string }).cap_id), ["r-0a1b2c3d4e"]);
});

test("restore: 残す 1 件は動いている記録（running・unknown・指示待ち）を最優先。旧 running + 新しい done なら running を残し、stop_cap は done へ送る。active が無ければ最新、active が複数なら最新の active", async () => {
  const stopped = async (recs: unknown[]) => {
    await writeFile(join(dir, "remotes.json"), JSON.stringify(recs));
    const { mgr, stops } = setup({}, undefined, undefined, undefined, { log: () => {} });
    await mgr.restore();
    await tick();
    return { kept: mgr.list().map((r) => r.remote_id), stopIds: stops.map((x) => (x.cmd as { cap_id: string }).cap_id).sort() };
  };
  // 旧 running + 新しい done → running を残す（done へだけ stop_cap）
  let o = await stopped([legacyRec("r-0a1b2c3d4e", { state: "running", createdAt: "2026-11-03T00:00:00.000Z" }), legacyRec("r-9f8e7d6c5b", { finishedAt: "2026-11-03T20:00:00.000Z" })]);
  assert.deepEqual(o, { kept: ["r-0a1b2c3d4e"], stopIds: ["r-9f8e7d6c5b"] });
  // 指示待ち（pending あり）も active
  o = await stopped([legacyRec("r-0a1b2c3d4e", { pending: [{ at: "2026-11-03T00:00:00.000Z", owner: "pm1", prompt: "p" }] }), legacyRec("r-9f8e7d6c5b", { finishedAt: "2026-11-03T20:00:00.000Z" })]);
  assert.deepEqual(o, { kept: ["r-0a1b2c3d4e"], stopIds: ["r-9f8e7d6c5b"] });
  // active が無ければ最新を残す
  o = await stopped([legacyRec("r-0a1b2c3d4e", { finishedAt: "2026-11-03T01:00:00.000Z" }), legacyRec("r-9f8e7d6c5b", { state: "failed", finishedAt: "2026-11-03T20:00:00.000Z" })]);
  assert.deepEqual(o, { kept: ["r-9f8e7d6c5b"], stopIds: ["r-0a1b2c3d4e"] });
  // active が複数なら最新の active を残し、他の active と done へ stop_cap
  o = await stopped([
    legacyRec("r-0a1b2c3d4e", { state: "running", createdAt: "2026-11-03T01:00:00.000Z" }),
    legacyRec("r-9f8e7d6c5b", { state: "running", createdAt: "2026-11-03T10:00:00.000Z" }),
    legacyRec("r-5a5a5a5a5a", { finishedAt: "2026-11-03T22:00:00.000Z" }),
  ]);
  assert.deepEqual(o, { kept: ["r-9f8e7d6c5b"], stopIds: ["r-0a1b2c3d4e", "r-5a5a5a5a5a"] });
});

test("restore: 新形式（center の cap_id）の active 記録は、より新しい finished の旧記録があっても残る。stop_cap は旧記録へ", async () => {
  const own: RemoteRecord = { remote_id: CAP, server: "id-a", serverName: "bantou-server", serverHost: "host-a", state: "running", createdAt: "2026-11-03T00:00:00.000Z", pending: [] };
  await writeFile(join(dir, "remotes.json"), JSON.stringify([own, legacyRec("r-0a1b2c3d4e", { finishedAt: "2026-11-03T20:00:00.000Z" })]));
  const { mgr, stops } = setup({}, undefined, undefined, undefined, { log: () => {} });
  await mgr.restore();
  assert.deepEqual(mgr.list().map((r) => r.remote_id), [CAP]);
  assert.deepEqual(stops.map((x) => (x.cmd as { cap_id: string }).cap_id), ["r-0a1b2c3d4e"]);
});

test("restore: 同名で host が違う 2 つの server は別の server。host 無しの旧記録が確かめられない（同名 peer が複数・peer が引けない）時は、グループ化も stop_cap もせずそのまま残す", async () => {
  const peerA3: ServerPeer = { id: "id-a3", name: "bantou-server", hostname: "host-z", version: "1.1.0" };
  const noHost = (id: string, over: Record<string, unknown> = {}) => {
    const r = legacyRec(id, over) as Record<string, unknown>;
    delete r.serverHost;
    return r;
  };
  const recs = [
    legacyRec("r-0a1b2c3d4e", { finishedAt: "2026-11-03T01:00:00.000Z" }), // host-a
    legacyRec("r-9f8e7d6c5b", { server: "id-a3", serverHost: "host-z", finishedAt: "2026-11-03T02:00:00.000Z" }), // host-z（同名の別 server）
    noHost("r-5a5a5a5a5a", { server: "old-id", finishedAt: "2026-11-03T03:00:00.000Z" }),
    noHost("r-6b6b6b6b6b", { server: "old-id2", finishedAt: "2026-11-03T04:00:00.000Z" }),
  ];
  // 同名 peer が 2 つ
  await writeFile(join(dir, "remotes.json"), JSON.stringify(recs));
  const a = setup({}, undefined, undefined, undefined, { log: () => {} });
  a.setPeers([peerA, peerA3, peerB]);
  await a.mgr.restore();
  assert.deepEqual(a.mgr.list().map((r) => r.remote_id).sort(), ["r-0a1b2c3d4e", "r-5a5a5a5a5a", "r-6b6b6b6b6b", "r-9f8e7d6c5b"]);
  assert.equal(a.stops.length, 0);
  // peer が引けない
  await writeFile(join(dir, "remotes.json"), JSON.stringify(recs));
  const b = setup({ peers: async () => { throw new Error("link down"); } }, undefined, undefined, undefined, { log: () => {} });
  await b.mgr.restore();
  assert.deepEqual(b.mgr.list().map((r) => r.remote_id).sort(), ["r-0a1b2c3d4e", "r-5a5a5a5a5a", "r-6b6b6b6b6b", "r-9f8e7d6c5b"]);
  assert.equal(b.stops.length, 0);
});

test("restore: host の無い旧記録（serverHost を持つ前）は名前で同じ server とみなし、1 件に畳む。peer id が変わっても旧共有 cap は 1 件のまま（session 無し）。次の指示は session の cap。status で host が埋まる", async () => {
  const noHost = (id: string, over: Record<string, unknown> = {}) => {
    const r = legacyRec(id, over) as Record<string, unknown>;
    delete r.serverHost;
    return r;
  };
  const own: RemoteRecord = { remote_id: CAP, server: "id-a", serverName: "bantou-server", serverHost: "host-a", state: "done", createdAt: "2026-11-03T12:00:00.000Z", pending: [] };
  await writeFile(join(dir, "remotes.json"), JSON.stringify([noHost("r-0a1b2c3d4e", { createdAt: "2026-11-03T00:00:00.000Z" }), noHost("r-9f8e7d6c5b", { createdAt: "2026-11-03T20:00:00.000Z" }), own]));
  const { mgr, stops, kicks, caps, setPeers } = setup({}, undefined, undefined, undefined, { log: () => {} });
  const peerA2: ServerPeer = { id: "id-a2", name: "bantou-server", hostname: "host-a", version: "1.1.0" }; // server の再起動で peer id が変わった
  setPeers([peerA2, peerB]);
  caps.set("id-a2", ["r-9f8e7d6c5b"]);
  await mgr.restore();
  assert.deepEqual(mgr.list().map((r) => r.remote_id), ["r-9f8e7d6c5b"]);
  assert.deepEqual(stops.map((x) => (x.cmd as { cap_id: string }).cap_id).sort(), [CAP, "r-0a1b2c3d4e"].sort());
  const r = await mgr.send({ owner: "pm1", goal: "go" });
  assert.equal(r.remote_id, CAP);
  assert.equal(r.created, true);
  assert.equal(kicks[0].cmd.cap_id, CAP);
  assert.equal(mgr.list().length, 2);
  const shared = mgr.list().find((x) => x.remote_id === "r-9f8e7d6c5b")!;
  assert.deepEqual([shared.server, shared.serverHost, shared.session], ["id-a2", "host-a", undefined]);
});

test("restore: host の無い旧記録は、起動時の status が成功したら今の peer id と host を記録に入れる（同名の server が複数いて決められない時は入れない）", async () => {
  const rec = { remote_id: "r-0a1b2c3d4e", server: "old-id", serverName: "bantou-server", state: "done", createdAt: "2026-11-03T00:00:00.000Z", pending: [] };
  await writeFile(join(dir, "remotes.json"), JSON.stringify([rec]));
  const one = setup({}, undefined, undefined, undefined, { log: () => {} });
  one.setPeers([peerA, peerB]);
  await one.mgr.restore();
  await sleep(30);
  assert.deepEqual([one.mgr.list()[0].server, one.mgr.list()[0].serverHost], ["id-a", "host-a"]);
  assert.equal((JSON.parse(await readFile(join(dir, "remotes.json"), "utf8")) as RemoteRecord[])[0].serverHost, "host-a");
  await writeFile(join(dir, "remotes.json"), JSON.stringify([rec]));
  const two = setup({}, undefined, undefined, undefined, { log: () => {} });
  two.setPeers([peerA, { ...peerA, id: "id-a-other", hostname: "host-z" }]);
  await two.mgr.restore();
  await sleep(30);
  assert.equal(two.mgr.list()[0].serverHost, undefined);
});

test("restore: 旧形式の running と未完了の指示（history 形式）は引き継いで status で追従する。cap_id ごとに指示する", async () => {
  const old = legacyRec("r-0a1b2c3d4e", { state: "running", history: [{ type: "instruction", at: "t1", owner: "pm1", prompt: "open one" }] });
  await writeFile(join(dir, "remotes.json"), JSON.stringify([old]));
  const { mgr, stops } = setup({}, undefined, undefined, undefined, { log: () => {} });
  await mgr.restore();
  const r = mgr.list()[0];
  assert.equal(r.remote_id, "r-0a1b2c3d4e");
  assert.deepEqual(r.pending, [{ at: "t1", owner: "pm1", prompt: "open one" }]);
  assert.equal(stops.length, 0);
});

test("cap_id は session × server: 同じ session は server が違っても同じ cap_id、session が違えば別の cap_id。旧共有 cap の cap_id は使わない", async () => {
  await writeFile(join(dir, "remotes.json"), JSON.stringify([legacyRec("r-0a1b2c3d4e")]));
  const { mgr, kicks, caps } = setup({}, undefined, undefined, undefined, { log: () => {} });
  caps.set("id-a", ["r-0a1b2c3d4e"]);
  await mgr.restore();
  const ra = await mgr.send({ owner: "pm1", goal: "a" });
  const rb = await mgr.send({ owner: "pm1", goal: "b", server: "id-b" });
  const rc = await mgr.send({ owner: "pm2", goal: "c" });
  assert.deepEqual([ra.remote_id, ra.created, rb.remote_id, rb.created, rc.remote_id, rc.created], [CAP, true, CAP, true, CAP2, true]);
  assert.deepEqual(kicks.map((k) => [k.peer.id, k.cmd.cap_id]), [["id-a", CAP], ["id-b", CAP], ["id-a", CAP2]]);
  // remote_id 省略の操作は複数の server にまたがるので server で絞らせる
  await assert.rejects(mgr.delete({ owner: "pm1" }), /複数の server/);
  assert.equal((await mgr.delete({ owner: "pm1", server: "id-a" })).remote_id, CAP);
  assert.deepEqual(mgr.list({ owner: "pm1" }).map((r) => r.server), ["id-b"]);
  assert.deepEqual(mgr.list({ owner: "pm2" }).map((r) => r.remote_id), [CAP2]);
});

test("記録は remote_delete 以外で消えない: 再起動（restore）を重ねても、done / failed / 古い記録も残る。remote_delete で初めて消える", async () => {
  const mk = (id: string, state: string, server: string, name: string, host: string) => ({ remote_id: id, server, serverName: name, serverHost: host, state, createdAt: "2026-11-03T00:00:00.000Z", pending: [] });
  const recs = [mk(CAP, "done", "id-a", "bantou-server", "host-a"), mk("c-other00000", "failed", "id-b", "other", "host-b")];
  await writeFile(join(dir, "remotes.json"), JSON.stringify(recs));
  for (let i = 0; i < 3; i++) {
    const { mgr, stops } = setup({}, undefined, undefined, undefined, { log: () => {} });
    await mgr.restore();
    assert.deepEqual(mgr.list().map((r) => r.remote_id).sort(), [CAP, "c-other00000"].sort(), `restart ${i}`);
    assert.equal(stops.length, 0);
  }
  const { mgr } = setup({}, undefined, undefined, undefined, { log: () => {} });
  await mgr.restore();
  await mgr.delete({ remote_id: CAP });
  assert.deepEqual(mgr.list().map((r) => r.remote_id), ["c-other00000"]);
  assert.deepEqual((JSON.parse(await readFile(join(dir, "remotes.json"), "utf8")) as RemoteRecord[]).map((r) => r.remote_id), ["c-other00000"]);
});

test("restore: 全ての記録の server へ status を cap_id 付きで送り、通知先を取り戻す（done の記録も。server が見えるまで再試行）", async () => {
  const recs: RemoteRecord[] = [
    { remote_id: CAP, server: "id-a", serverName: "bantou-server", serverHost: "host-a", state: "done", createdAt: "2026-11-04T00:00:00.000Z", pending: [] },
    { remote_id: "c-bbbbbbbbbb", server: "id-b", serverName: "other", serverHost: "host-b", state: "failed", createdAt: "2026-11-04T00:00:00.000Z", pending: [] },
  ];
  await writeFile(join(dir, "remotes.json"), JSON.stringify(recs));
  const calls: [string, string | undefined][] = [];
  const { mgr, setPeers } = setup({
    statusOn: async (peer: ServerPeer, opts?: { cap_id?: string }) => {
      calls.push([peer.id, opts?.cap_id]);
      return { bantou: 1, type: "status_result", ok: true, caps: [], workers: [] } as never;
    },
  }, undefined, undefined, undefined, { log: () => {} });
  setPeers([]); // 起動直後は server がまだ見えない
  await mgr.restore();
  await sleep(POLL * 2);
  assert.deepEqual(calls, []);
  setPeers([peerA, peerB]);
  await sleep(POLL * 2);
  assert.deepEqual([...calls].sort(), [["id-a", CAP], ["id-b", "c-bbbbbbbbbb"]]);
  const n = calls.length;
  await sleep(POLL * 3);
  assert.equal(calls.length, n); // 伝わったら止まる
});

test("restore: running の記録は状態の追従の status が cap_id 付きで通知先を兼ねる。send の status も cap_id 付き", async () => {
  const rec: RemoteRecord = { remote_id: CAP, server: "id-a", serverName: "bantou-server", serverHost: "host-a", state: "running", createdAt: "2026-11-04T00:00:00.000Z", pending: [] };
  await writeFile(join(dir, "remotes.json"), JSON.stringify([rec]));
  const calls: (string | undefined)[] = [];
  const { mgr } = setup({
    statusOn: async (_p: ServerPeer, opts?: { cap_id?: string }) => {
      calls.push(opts?.cap_id);
      return { bantou: 1, type: "status_result", ok: true, caps: [{ kind: "cap", id: CAP, state: "idle" }], workers: [] } as never;
    },
  }, undefined, undefined, undefined, { log: () => {} });
  await mgr.restore();
  await sleep(20);
  assert.deepEqual(calls, [CAP]); // probe の 1 回だけ（announce と二重にしない）
  await mgr.send({ owner: "pm1", goal: "x" });
  assert.deepEqual(calls, [CAP, CAP]);
});

test("restore: 履歴を持っていた版の cap の記録は、未完了の指示だけ引き継いで history を捨てる", async () => {
  const rec = {
    remote_id: CAP, server: "id-a", serverName: "bantou-server", state: "done", createdAt: "2026-11-04T00:00:00.000Z", result: "r",
    history: [
      { type: "instruction", at: "t1", owner: "pm1", prompt: "done one", done_at: "t2" },
      { type: "result", at: "t2", ok: true, text: "r" },
      { type: "instruction", at: "t3", owner: "pm2", prompt: "open one" },
    ],
  };
  await writeFile(join(dir, "remotes.json"), JSON.stringify([rec]));
  const { mgr } = setup({}, undefined, undefined, undefined, { log: () => {} });
  await mgr.restore();
  const r = mgr.list()[0];
  assert.equal("history" in r, false);
  assert.deepEqual(r.pending, [{ at: "t3", owner: "pm2", prompt: "open one" }]);
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

// -- task_result / worker_report / worker_reply（protocol 1.5.0） --

const fullResult = (taskId: string, over: object = {}) => ({
  ...ok("全部やった", taskId),
  workers: [{ worker_id: "w-1", role: "implement", state: "done", branch: "feature/x", commit: "abc1234", tests: "npm test: 41 pass", result: "実装した" }],
  review: { verdict: "issues", items: [{ severity: "low", text: "命名", resolved: true }], rounds: 2 },
  remaining: ["docs 未更新"],
  ...over,
});
const report = (kind: string, workerId = "w-1", text = "経過", over: object = {}) => ({
  bantou: 1 as const, type: "worker_report" as const, cap_id: CAP, task_id: "t-1", worker_id: workerId, kind: kind as never, text, at: "2026-11-04T00:00:00.000Z", ...over,
});

test("task_result: 最新の task_result 本体を task_result に持ち、result は summary。worker_reports は最初は空", async () => {
  const { mgr, kicks } = setup();
  const r = await mgr.send({ owner: "pm1", goal: "g" });
  assert.deepEqual(mgr.list()[0].worker_reports, []);
  assert.ok(!("task_result" in mgr.list()[0]));
  const tr = fullResult(r.task_id);
  kicks[0].resolve(tr);
  await tick();
  mgr.onActivity(CAP);
  const v = mgr.list()[0];
  assert.deepEqual(v.task_result, tr);
  assert.equal(v.result, "全部やった");
  assert.equal(v.state, "done");
  const saved = JSON.parse(await readFile(join(dir, "remotes.json"), "utf8")) as RemoteRecord[];
  assert.deepEqual(saved[0].task_result, tr);
});

test("task_result: state=failed は failed + error、task_result も残る。次の task_result で置き換わる", async () => {
  const { mgr, kicks } = setup();
  const a = await mgr.send({ owner: "pm1", goal: "a" });
  kicks[0].resolve(fullResult(a.task_id, { state: "failed", error: "worker が落ちた", summary: "途中" }));
  await tick();
  mgr.onActivity(CAP);
  assert.deepEqual([mgr.list()[0].state, mgr.list()[0].error, mgr.list()[0].result], ["failed", "worker が落ちた", "途中"]);
  assert.equal(mgr.list()[0].task_result?.state, "failed");
  const b = await mgr.send({ owner: "pm1", goal: "b" });
  kicks[1].resolve(fullResult(b.task_id));
  await tick();
  mgr.onActivity(CAP);
  assert.equal(mgr.list()[0].task_result?.task_id, b.task_id);
  assert.equal(mgr.list()[0].state, "done");
});

test("完了判定: 同じ task_id の task_result が重ねて届いても完了通知は 1 回。task_result は最新に更新される", async () => {
  const n = notifier();
  const { mgr, kicks } = setup({}, undefined, n.notify);
  const r = await mgr.send({ owner: "pm1", goal: "g" });
  kicks[0].resolve(fullResult(r.task_id));
  await tick();
  mgr.onActivity(CAP);
  await tick();
  assert.equal(n.sent.length, 1);
  assert.match(n.sent[0].text, /全部やった/);
  // report 起因の再開で、同じ task_id の task_result がもう一度来る
  assert.equal(mgr.applyLateReply(fullResult(r.task_id, { summary: "再開後" }) as never), true);
  await tick();
  mgr.onActivity(CAP);
  await sleep(GRACE + 30);
  assert.equal(n.sent.length, 1);
  assert.equal(mgr.list()[0].task_result?.summary, "再開後");
  assert.deepEqual(mgr.list()[0].pending, []);
  assert.equal(mgr.list()[0].state, "done");
});

test("完了判定: 返信待ちの task と別の task_id の task_result（過去の task の遅れ）は記録に反映するが、待ちの間は running のまま", async () => {
  const { mgr, kicks } = setup();
  const r = await mgr.send({ owner: "pm1", goal: "g" });
  assert.equal(mgr.applyLateReply(ok("過去の task", "t-old") as never), true);
  assert.equal(mgr.list()[0].task_result?.task_id, "t-old");
  assert.equal(mgr.list()[0].state, "running");
  kicks[0].resolve(fullResult(r.task_id));
  await tick();
  assert.equal(mgr.list()[0].task_result?.task_id, r.task_id);
});

test("worker_report: 記録に到着順で積み（最大 20 件）、remote_list に worker_reports で出る。記録が無い cap_id は捨てる", async () => {
  const { mgr } = setup();
  mgr.onWorkerReport(report("done") as never); // 記録が無い
  await mgr.send({ owner: "pm1", goal: "g" });
  for (let i = 0; i < 25; i++) mgr.onWorkerReport(report("ask", "w-1", `q${i}`) as never);
  mgr.onWorkerReport(report("done", "w-1", "x", { cap_id: "other" }) as never);
  const wr = mgr.list()[0].worker_reports;
  assert.equal(wr.length, 20);
  assert.deepEqual([wr[0].text, wr[19].text], ["q5", "q24"]);
  assert.deepEqual(mgr.list({ owner: "pm1" })[0].worker_reports.length, 20);
  await sleep(80); // 保存（非同期）を待つ
  const saved = JSON.parse(await readFile(join(dir, "remotes.json"), "utf8")) as RemoteRecord[];
  assert.equal(saved[0].worker_reports?.length, 20);
});

test("worker_report: cap の session へ push する（別 session の cap の report は別 session へ）。ask / approve には返答の案内", async () => {
  const n = notifier();
  const { mgr } = setup({}, undefined, n.notify);
  await mgr.send({ owner: "pm1", goal: "a" });
  await mgr.send({ owner: "pm2", goal: "b" });
  mgr.onWorkerReport(report("ask", "w-9", "A と B のどちら？") as never);
  await tick();
  assert.deepEqual(n.sent.map((x) => x.owner), ["pm1"]);
  assert.match(n.sent[0].text, /^\[bantou\] worker_report remote_id=c-0123456789-pm1 worker=w-9 kind=ask task_id=t-1\nA と B のどちら？\n返答: worker_reply\(worker_id="w-9", text\)/);
  mgr.onWorkerReport(report("done", "w-9", "終わった", { task_id: undefined }) as never);
  await tick();
  assert.equal(n.sent.length, 2);
  assert.ok(!/返答:/.test(n.sent[1].text));
  assert.ok(!/task_id=/.test(n.sent[1].text));
  mgr.onWorkerReport({ ...(report("ask", "w-2", "pm2 の cap") as object), cap_id: CAP2 } as never);
  await tick();
  assert.deepEqual(n.sent.map((x) => x.owner), ["pm1", "pm1", "pm2"]);
});

test("worker_report: progress は同じ worker から 60 秒に 1 回まで（別 worker は別枠）。ask / approve / done は毎回。間引いても記録には積む", async () => {
  let t = 1_000_000;
  const now = mock.method(Date, "now", () => t);
  try {
    const n = notifier();
    const { mgr } = setup({}, undefined, n.notify);
    await mgr.send({ owner: "pm1", goal: "g" });
    mgr.onWorkerReport(report("progress", "w-1", "p1") as never);
    mgr.onWorkerReport(report("progress", "w-1", "p2") as never);
    mgr.onWorkerReport(report("progress", "w-2", "p3") as never);
    await tick();
    assert.deepEqual(n.sent.map((x) => x.text.split("\n")[1]), ["p1", "p3"]);
    t += 59_000;
    mgr.onWorkerReport(report("progress", "w-1", "p4") as never);
    mgr.onWorkerReport(report("ask", "w-1", "q1") as never);
    mgr.onWorkerReport(report("approve", "w-1", "ok?") as never);
    mgr.onWorkerReport(report("done", "w-1", "fin") as never);
    await tick();
    assert.deepEqual(n.sent.map((x) => x.text.split("\n")[1]), ["p1", "p3", "q1", "ok?", "fin"]);
    t += 1_000;
    mgr.onWorkerReport(report("progress", "w-1", "p5") as never);
    await tick();
    assert.equal(n.sent[n.sent.length - 1].text.split("\n")[1], "p5");
    assert.equal(mgr.list()[0].worker_reports.length, 8);
  } finally {
    now.mock.restore();
  }
});

test("worker_report: 未完了の指示が無くても cap の session へ push する。通知先が無い時は push せず、記録だけ残す。通知の失敗・throw で落ちない", async () => {
  const n = notifier();
  const { mgr, kicks } = setup({}, undefined, n.notify);
  const r = await mgr.send({ owner: "pm1", goal: "g" });
  kicks[0].resolve(fullResult(r.task_id));
  await tick();
  mgr.onActivity(CAP); // 完了（未完了の指示 0 件）
  await tick();
  const before = n.sent.length;
  mgr.onWorkerReport(report("ask") as never);
  await tick();
  assert.equal(n.sent.length, before + 1);
  assert.equal(n.sent[before].owner, "pm1");
  assert.equal(mgr.list()[0].worker_reports.length, 1);
  const none = setup();
  await none.mgr.send({ owner: "pm1", goal: "g" });
  none.mgr.onWorkerReport(report("ask") as never);
  assert.equal(none.mgr.list()[0].worker_reports.length, 1);
  const bad = setup({}, undefined, (async () => { throw new Error("push 失敗"); }) as never);
  await bad.mgr.send({ owner: "pm1", goal: "g" });
  bad.mgr.onWorkerReport(report("ask") as never);
  await tick();
  assert.equal(bad.mgr.list()[0].worker_reports.length, 1);
});

test("workerReply: center の cap（remote_id 省略）の server へ {cap_id, worker_id, text} を送り、accepted を返す", async () => {
  const sent: { peer: ServerPeer; cmd: unknown }[] = [];
  const { mgr } = setup({
    workerReplyOn: async (peer: ServerPeer, cmd: unknown) => {
      sent.push({ peer, cmd });
      return { bantou: 1, type: "worker_reply_result", ok: true, cap_id: CAP, worker_id: "w-1", accepted: true };
    },
  } as never);
  await mgr.send({ owner: "pm1", goal: "g" });
  const r = await mgr.workerReply({ worker_id: "w-1", text: "OK 進めて" });
  assert.deepEqual(r, { remote_id: CAP, server: "id-a", worker_id: "w-1", accepted: true });
  assert.equal(sent[0].peer.id, "id-a");
  assert.deepEqual(sent[0].cmd, { cap_id: CAP, worker_id: "w-1", text: "OK 進めて" });
  // remote_id を明示してもよい
  await mgr.workerReply({ remote_id: CAP, worker_id: "w-1", text: "again" });
  assert.equal(sent.length, 2);
});

test("workerReply: error 返信・門（版違い）・未定義の remote・不正な入力は投げ、版違いの時は server へ送らない", async () => {
  let calls = 0;
  const { mgr } = setup({
    workerReplyOn: async () => {
      calls++;
      return { bantou: 1, type: "error", ok: false, message: "worker が無い", command: "worker_reply" };
    },
  } as never);
  await mgr.send({ owner: "pm1", goal: "g" });
  await assert.rejects(mgr.workerReply({ worker_id: "w-1", text: "x" }), /worker が無い/);
  assert.equal(calls, 1);
  await assert.rejects(mgr.workerReply({ remote_id: "c-zzz", worker_id: "w-1", text: "x" }), /未定義の remote/);
  await assert.rejects(mgr.workerReply({ worker_id: "a b", text: "x" }), /worker_id/);
  await assert.rejects(mgr.workerReply({ worker_id: "w-1", text: "" }), /text/);
  await assert.rejects(mgr.workerReply({ worker_id: "w-1", text: "a\0b" }), /text/);
  assert.equal(calls, 1);
  const gated = setup({
    gate: (_p: ServerPeer, command: string) => (command === "worker_reply" ? { bantou: 1, type: "error", ok: false, message: "server の protocol の版が合わない（server=1.4.0, center=1.5.0）", code: "version_mismatch", retryable: true } : undefined),
    workerReplyOn: async () => {
      calls++;
      return { bantou: 1, type: "worker_reply_result", ok: true, cap_id: CAP, worker_id: "w-1", accepted: true };
    },
  } as never);
  await gated.mgr.send({ owner: "pm1", goal: "g" }).catch(() => undefined);
  await assert.rejects(gated.mgr.workerReply({ worker_id: "w-1", text: "x" }), /版が合わない|未定義の remote/);
  assert.equal(calls, 1);
});

test("旧 server（protocol_version 不一致）: task も worker_reply も送らず投げる。記録は作らない", async () => {
  const gate = (_p: ServerPeer, command: string) =>
    command === "task" || command === "worker_reply"
      ? { bantou: 1, type: "error", ok: false, message: "server の protocol の版が合わない（server=1.4.0, center=1.5.0）", code: "version_mismatch", retryable: true, command }
      : undefined;
  const { mgr, kicks } = setup({ gate } as never);
  await assert.rejects(mgr.send({ owner: "pm1", goal: "g" }), /版が合わない/);
  assert.equal(kicks.length, 0);
  assert.equal(mgr.list().length, 0);
});

// -- session ごとの remote 集計（summary）と SSE 用の onSummaryChange --

const replyOk = {
  workerReplyOn: async (_p: ServerPeer, cmd: { cap_id: string; worker_id: string }) => ({ bantou: 1, type: "worker_reply_result", ok: true, cap_id: cmd.cap_id, worker_id: cmd.worker_id, accepted: true }),
} as never;

test("summary: 未完了の指示がある server の数 (running) と、未返答の ask / approve の数 (waitingReply)。progress / done・他 session の cap は数えない", async () => {
  const { mgr, kicks } = setup();
  assert.deepEqual(mgr.summary("pm1"), { running: 0, waitingReply: 0 });
  const r = await mgr.send({ owner: "pm1", goal: "a" });
  await mgr.send({ owner: "pm1", goal: "b", server: "id-b" });
  await mgr.send({ owner: "pm2", goal: "c" });
  assert.deepEqual(mgr.summary("pm1"), { running: 2, waitingReply: 0 });
  assert.deepEqual(mgr.summary("pm2"), { running: 1, waitingReply: 0 });
  mgr.onWorkerReport(report("ask", "w-1") as never, "id-a");
  mgr.onWorkerReport(report("approve", "w-2") as never, "id-a");
  mgr.onWorkerReport(report("progress", "w-3") as never, "id-a");
  mgr.onWorkerReport(report("done", "w-4") as never, "id-a");
  mgr.onWorkerReport(report("ask", "w-1", "x", { cap_id: CAP2 }) as never);
  assert.deepEqual(mgr.summary("pm1"), { running: 2, waitingReply: 2 });
  assert.deepEqual(mgr.summary("pm2"), { running: 1, waitingReply: 1 });
  // 完了すれば running が減り、止まった cap の未返答 ask は数えない
  kicks[0].resolve(ok("r", r.task_id));
  await sleep(GRACE + 120);
  assert.deepEqual(mgr.summary("pm1"), { running: 1, waitingReply: 0 });
});

test("summary: worker_reply で、その worker の未返答 ask / approve が減る（別の worker の分は残る）。replied_at が記録に付く", async () => {
  const { mgr } = setup(replyOk);
  await mgr.send({ owner: "pm1", goal: "g" });
  mgr.onWorkerReport(report("ask", "w-1", "q1") as never);
  mgr.onWorkerReport(report("approve", "w-3", "q2") as never);
  mgr.onWorkerReport(report("ask", "w-2", "q3") as never);
  assert.equal(mgr.summary("pm1").waitingReply, 3);
  await mgr.workerReply({ worker_id: "w-1", text: "OK" });
  assert.equal(mgr.summary("pm1").waitingReply, 2);
  await mgr.workerReply({ worker_id: "w-3", text: "OK" });
  const wr = mgr.list()[0].worker_reports;
  assert.deepEqual(wr.map((w) => w.replied_at !== undefined), [true, true, false]);
  assert.equal(mgr.summary("pm1").waitingReply, 1);
  // 送れなかった返答では減らない
  const bad = setup({ workerReplyOn: async () => { throw new Error("届かない"); } } as never);
  await bad.mgr.send({ owner: "pm1", goal: "g" });
  bad.mgr.onWorkerReport(report("ask", "w-1") as never);
  await assert.rejects(bad.mgr.workerReply({ worker_id: "w-1", text: "x" }), /届かない/);
  assert.equal(bad.mgr.summary("pm1").waitingReply, 1);
});

test("summary: center 再起動（同じ store で restore）後も返答済みが保たれる。未返答は残る", async () => {
  const a = setup(replyOk);
  await a.mgr.send({ owner: "pm1", goal: "g" });
  a.mgr.onWorkerReport(report("ask", "w-1", "q1") as never);
  a.mgr.onWorkerReport(report("ask", "w-2", "q2") as never);
  await a.mgr.workerReply({ worker_id: "w-1", text: "OK" });
  await sleep(80); // 保存（非同期）を待つ
  const b = setup({ statusOn: async () => ({ bantou: 1, type: "status_result", ok: true, caps: [{ kind: "cap", id: CAP }], workers: [] }) as never });
  await b.mgr.restore();
  assert.deepEqual(b.mgr.summary("pm1"), { running: 1, waitingReply: 1 });
  assert.deepEqual(b.mgr.list()[0].worker_reports.map((w) => [w.worker_id, w.replied_at !== undefined]), [["w-1", true], ["w-2", false]]);
});

test("onSummaryChange: task 送信・worker_report (ask)・worker_reply・完了・delete で、集計が変わった session にだけ 1 回ずつ呼ぶ。変わらない report (progress) では呼ばない", async () => {
  const calls: string[] = [];
  const { mgr, kicks } = setup(replyOk, undefined, undefined, undefined, { onSummaryChange: (s) => calls.push(s) });
  const r = await mgr.send({ owner: "pm1", goal: "g" });
  assert.deepEqual(calls, ["pm1"]);
  mgr.onWorkerReport(report("progress") as never);
  assert.deepEqual(calls, ["pm1"]);
  mgr.onWorkerReport(report("ask") as never);
  assert.deepEqual(calls, ["pm1", "pm1"]);
  await mgr.workerReply({ worker_id: "w-1", text: "OK" });
  assert.equal(calls.length, 3);
  kicks[0].resolve(ok("r", r.task_id));
  await sleep(GRACE + 120);
  assert.equal(calls.length, 4); // running 1 -> 0
  await mgr.send({ owner: "pm1", goal: "again" });
  assert.equal(calls.length, 5);
  await mgr.delete({ owner: "pm1", force: true });
  assert.equal(calls.length, 6); // running 1 -> 0
  assert.ok(calls.every((c) => c === "pm1"));
});

test("SSE: onSummaryChange を EventHub.publish({ reason: \"remote\", name: session }) に繋ぐと、集計が変わるたびに購読者へ流れる（daemon.ts と同じ繋ぎ方）", async () => {
  const events = createEventHub();
  const got: { reason: string; name: string }[] = [];
  events.subscribe((ev) => got.push(ev));
  const { mgr } = setup(replyOk, undefined, undefined, undefined, { onSummaryChange: (name) => events.publish({ reason: "remote", name }) });
  await mgr.send({ owner: "pm1", goal: "g" });
  mgr.onWorkerReport(report("ask") as never);
  await mgr.workerReply({ worker_id: "w-1", text: "OK" });
  assert.deepEqual(got, [{ reason: "remote", name: "pm1" }, { reason: "remote", name: "pm1" }, { reason: "remote", name: "pm1" }]);
});

// -- 返答なしで worker が先へ進んだ ask / approve の解消（superseded_at） --

test("superseded: 同じ worker から done / 新しい ask / approve が来ると前の未返答は解消され、waitingReply に数えない。progress・別 worker は解消しない", async () => {
  const { mgr } = setup();
  await mgr.send({ owner: "pm1", goal: "g" });
  mgr.onWorkerReport(report("ask", "w-1", "q1") as never);
  mgr.onWorkerReport(report("ask", "w-2", "q2") as never);
  assert.equal(mgr.summary("pm1").waitingReply, 2);
  mgr.onWorkerReport(report("progress", "w-1", "進捗") as never);
  assert.equal(mgr.summary("pm1").waitingReply, 2);
  mgr.onWorkerReport(report("done", "w-3", "別 worker") as never);
  assert.equal(mgr.summary("pm1").waitingReply, 2);
  mgr.onWorkerReport(report("done", "w-1", "終わった") as never);
  assert.equal(mgr.summary("pm1").waitingReply, 1);
  const wr = mgr.list()[0].worker_reports;
  assert.deepEqual(wr.map((w) => [w.text, w.superseded_at !== undefined, w.replied_at !== undefined]), [["q1", true, false], ["q2", false, false], ["進捗", false, false], ["別 worker", false, false], ["終わった", false, false]]);
  // 新しい ask / approve は前の未返答を解消し、最新の 1 件だけ数える
  mgr.onWorkerReport(report("approve", "w-2", "q2b") as never);
  assert.equal(mgr.summary("pm1").waitingReply, 1);
  mgr.onWorkerReport(report("ask", "w-2", "q2c") as never);
  assert.equal(mgr.summary("pm1").waitingReply, 1);
  assert.deepEqual(mgr.list()[0].worker_reports.filter((w) => w.worker_id === "w-2").map((w) => w.superseded_at !== undefined), [true, true, false]);
});

test("superseded: 未知の kind（failed など progress 以外）でも解消。別 cap の report では解消しない。返答済みには superseded_at を付けない", async () => {
  const { mgr } = setup(replyOk);
  await mgr.send({ owner: "pm1", goal: "g" });
  await mgr.send({ owner: "pm2", goal: "g" });
  mgr.onWorkerReport(report("ask", "w-1", "q1") as never);
  mgr.onWorkerReport(report("ask", "w-1", "q2", { cap_id: CAP2 }) as never);
  mgr.onWorkerReport(report("done", "w-1", "別 cap", { cap_id: CAP2 }) as never);
  assert.equal(mgr.summary("pm1").waitingReply, 1);
  assert.equal(mgr.summary("pm2").waitingReply, 0);
  mgr.onWorkerReport(report("failed", "w-1", "失敗") as never);
  assert.equal(mgr.summary("pm1").waitingReply, 0);
  mgr.onWorkerReport(report("ask", "w-5", "q5") as never);
  await mgr.workerReply({ owner: "pm1", worker_id: "w-5", text: "OK" });
  mgr.onWorkerReport(report("done", "w-5") as never);
  const w5 = mgr.list({ owner: "pm1" })[0].worker_reports.find((w) => w.text === "q5");
  assert.equal(w5?.replied_at !== undefined && w5.superseded_at === undefined, true);
});

test("superseded: center 再起動後も保たれる。20 件上限で押し出されたら記録ごと消えるので数えない", async () => {
  const a = setup();
  await a.mgr.send({ owner: "pm1", goal: "g" });
  a.mgr.onWorkerReport(report("ask", "w-1", "q1") as never);
  a.mgr.onWorkerReport(report("ask", "w-2", "q2") as never);
  a.mgr.onWorkerReport(report("done", "w-1") as never);
  await sleep(80);
  const b = setup({ statusOn: async () => ({ bantou: 1, type: "status_result", ok: true, caps: [{ kind: "cap", id: CAP }], workers: [] }) as never });
  await b.mgr.restore();
  assert.equal(b.mgr.summary("pm1").waitingReply, 1);
  assert.deepEqual(b.mgr.list()[0].worker_reports.filter((w) => w.kind === "ask").map((w) => w.superseded_at !== undefined), [true, false]);
  // 上限: 未返答の ask が progress で押し出されると数えなくなる（既知の限界）
  for (let i = 0; i < 20; i++) b.mgr.onWorkerReport(report("progress", "w-9", `p${i}`) as never);
  assert.equal(b.mgr.summary("pm1").waitingReply, 0);
});

test("superseded: 解消で集計が変わる時だけ onSummaryChange（SSE reason remote）が 1 回。変わらない時は流れない", async () => {
  const events = createEventHub();
  const got: string[] = [];
  events.subscribe((ev) => got.push(`${ev.reason}:${ev.name}`));
  const { mgr } = setup({}, undefined, undefined, undefined, { onSummaryChange: (name) => events.publish({ reason: "remote", name }) });
  await mgr.send({ owner: "pm1", goal: "g" });
  mgr.onWorkerReport(report("ask", "w-1") as never);
  assert.deepEqual(got, ["remote:pm1", "remote:pm1"]);
  mgr.onWorkerReport(report("progress", "w-1") as never);
  assert.equal(got.length, 2);
  mgr.onWorkerReport(report("done", "w-1") as never);
  assert.equal(got.length, 3);
  mgr.onWorkerReport(report("done", "w-1") as never);
  assert.equal(got.length, 3);
});

// -- 動いている cap の判定を stateOf に揃える・通知漏れ・worker_reply の競合 --

test("summary: pending が空で r.state が done でも、stateOf が running（worker が動いている）なら未返答 ask を数え、その変化（activity）で onSummaryChange が流れる", async () => {
  const activity = createActivityStore();
  const calls: string[] = [];
  const { mgr, kicks } = setup({}, activity, undefined, undefined, { onSummaryChange: (s) => calls.push(s) });
  const r = await mgr.send({ owner: "pm1", goal: "g" });
  mgr.onWorkerReport(report("ask") as never);
  kicks[0].resolve(ok("first", r.task_id));
  await tick();
  activity.apply(act("idle"), "id-a");
  mgr.onActivity(CAP, "id-a"); // 完了: pending が空になる
  await tick();
  assert.equal(mgr.list()[0].pending.length, 0);
  assert.equal(mgr.list()[0].state, "done");
  assert.deepEqual(mgr.summary("pm1"), { running: 0, waitingReply: 0 }, "止まった cap の未返答は数えない");
  const before = calls.length;
  // report 起因の再開: pending は空のまま worker が動き出す（persist を通らない変化）
  activity.apply(act("idle", "running"), "id-a");
  mgr.onActivity(CAP, "id-a");
  assert.equal(mgr.list()[0].state, "running");
  assert.equal(mgr.list()[0].pending.length, 0);
  assert.deepEqual(mgr.summary("pm1"), { running: 0, waitingReply: 1 });
  assert.equal(calls.length, before + 1);
  // 変化が無ければ流さない
  mgr.onActivity(CAP, "id-a");
  assert.equal(calls.length, before + 1);
  // 全員終われば数えなくなり、その変化も流れる
  activity.apply(act("idle", "done"), "id-a");
  mgr.onActivity(CAP, "id-a");
  assert.deepEqual(mgr.summary("pm1"), { running: 0, waitingReply: 0 });
  assert.equal(calls.length, before + 2);
});

test("workerReply: 送信の await 中に届いた同じ worker の新しい ask には replied_at を付けない（送った時点で返答待ちだった分だけ）", async () => {
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => (release = r));
  const { mgr } = setup({
    workerReplyOn: async (_p: ServerPeer, cmd: { cap_id: string; worker_id: string }) => {
      await gate;
      return { bantou: 1, type: "worker_reply_result", ok: true, cap_id: cmd.cap_id, worker_id: cmd.worker_id, accepted: true };
    },
  } as never);
  await mgr.send({ owner: "pm1", goal: "g" });
  mgr.onWorkerReport(report("ask", "w-1", "q1") as never);
  const p = mgr.workerReply({ worker_id: "w-1", text: "OK" });
  await tick();
  mgr.onWorkerReport(report("ask", "w-1", "q2") as never); // q1 は superseded になり、q2 が返答待ち
  release();
  await p;
  const wr = mgr.list()[0].worker_reports;
  assert.deepEqual(wr.map((w) => [w.text, w.replied_at !== undefined, w.superseded_at !== undefined]), [["q1", false, true], ["q2", false, false]]);
  assert.equal(mgr.summary("pm1").waitingReply, 1);
});

test("restore: 復元で集計が 0 から変わった session は、復元後に onSummaryChange が流れる（restore の前に接続していた受け手が取り直せる）", async () => {
  const a = setup();
  await a.mgr.send({ owner: "pm1", goal: "g" });
  a.mgr.onWorkerReport(report("ask") as never);
  await sleep(80);
  const calls: string[] = [];
  const b = setup({ statusOn: async () => ({ bantou: 1, type: "status_result", ok: true, caps: [{ kind: "cap", id: CAP }], workers: [] }) as never }, undefined, undefined, undefined, { onSummaryChange: (s) => calls.push(s) });
  await b.mgr.restore();
  assert.ok(calls.includes("pm1"));
  assert.equal(calls.filter((c) => c === "pm1").length, 1);
});
