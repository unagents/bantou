import assert from "node:assert/strict";
import { test } from "node:test";
import type { ErrorReply, HelloResultReply, UpdateResultReply } from "@agent-hand/bantou-protocol";
import { MESSENGER_PROTOCOL } from "@agent-hand/bantou-protocol";
import { compareVersions, createFollow, type Follow } from "../src/follow.js";
import type { ServerLink, ServerPeer } from "../src/server-link.js";

const PV = MESSENGER_PROTOCOL.version;
const running = { caps: 1, workers: 2, reports: 0 };

const hello = (over: Partial<HelloResultReply> = {}): HelloResultReply => ({
  bantou: 1, type: "hello_result", ok: true, server_version: "0.3.0", protocol_version: PV, update: null, last_update: null, ...over,
});
const updResult = (state: UpdateResultReply["state"], to = "0.3.1"): UpdateResultReply => ({
  bantou: 1, type: "update_result", ok: true, state, from: "0.3.0", to, running,
});
const err = (message: string, over: Partial<ErrorReply> = {}): ErrorReply => ({
  bantou: 1, type: "error", ok: false, message, ...over,
});
const peer = (over: Partial<ServerPeer> = {}): ServerPeer => ({
  id: "id-1", name: "bantou-server", summary: "host /ws", hostname: "host", version: PV, ...over,
});

interface Fake {
  link: ServerLink;
  peers: ServerPeer[];
  failPeers: boolean;
  helloReply: (p: ServerPeer) => HelloResultReply | ErrorReply;
  updateReply: (p: ServerPeer, v: string) => UpdateResultReply | ErrorReply;
  hellos: string[];
  updates: Array<[string, string]>;
}

function fake(): Fake {
  const f: Fake = {
    peers: [peer()],
    failPeers: false,
    helloReply: () => hello(),
    updateReply: () => updResult("waiting"),
    hellos: [],
    updates: [],
    link: undefined as never,
  };
  f.link = {
    peers: async () => {
      if (f.failPeers) throw new Error("no broker");
      return f.peers;
    },
    hello: async (p: ServerPeer) => {
      f.hellos.push(p.id);
      return f.helloReply(p);
    },
    updateServer: async (p: ServerPeer, v: string) => {
      f.updates.push([p.id, v]);
      return f.updateReply(p, v);
    },
  } as unknown as ServerLink;
  return f;
}

function mk(
  f: Fake,
  pairServer: string | null = "0.3.1",
  extra: { now?: () => number; lostAfterMs?: number; retryAfterMs?: number; sessionOfCap?: (capId: string) => string | undefined } = {},
): Follow {
  return createFollow({ link: f.link, pair: { server: pairServer ?? undefined, protocol: PV }, log: () => {}, ...extra });
}

const only = (fl: Follow) => fl.snapshot().peers[0];

test("compareVersions", () => {
  assert.ok(compareVersions("1.2.0", "1.3.0") < 0);
  assert.ok(compareVersions("1.3.0", "1.3.0") === 0);
  assert.ok(compareVersions("1.10.0", "1.3.0") > 0);
  assert.ok(compareVersions("2.0.0-rc.1", "1.9.9") > 0);
});

test("版が違えば update_server を組の版で指示し、updating（待っている件数つき）", async () => {
  const f = fake();
  const fl = mk(f);
  await fl.check();
  assert.deepEqual(f.updates, [["id-1", "0.3.1"]]);
  const e = only(fl);
  assert.equal(e.state, "updating");
  assert.equal(e.server_version, "0.3.0");
  assert.deepEqual(e.update, { to: "0.3.1", running });
  assert.match(e.detail, /更新中/);
  assert.deepEqual(fl.snapshot().pair, { server: "0.3.1", protocol: PV });
});

test("版が揃っていれば ok で、update_server は送らない", async () => {
  const f = fake();
  f.helloReply = () => hello({ server_version: "0.3.1" });
  const fl = mk(f);
  await fl.check();
  assert.equal(only(fl).state, "ok");
  assert.deepEqual(f.updates, []);
});

test("新旧は比べない: server の方が新しくても組の版へ指示する", async () => {
  const f = fake();
  f.helloReply = () => hello({ server_version: "0.9.0" });
  await mk(f).check();
  assert.deepEqual(f.updates, [["id-1", "0.3.1"]]);
});

test("server が更新中と答えたら（組の版への更新）updating で、重ねて指示しない", async () => {
  const f = fake();
  f.helloReply = () => hello({ update: { state: "waiting", from: "0.3.0", to: "0.3.1", running } });
  const fl = mk(f);
  await fl.check();
  assert.equal(only(fl).state, "updating");
  assert.deepEqual(f.updates, []);
});

test("protocol 1.3.0 未満・版不明は unsupported（hello も送らない）", async () => {
  for (const version of ["1.2.0", undefined]) {
    const f = fake();
    f.peers = [peer({ version })];
    const fl = mk(f);
    await fl.check();
    assert.equal(only(fl).state, "unsupported");
    assert.match(only(fl).detail, /手動/);
    assert.deepEqual(f.hellos, []);
    assert.deepEqual(f.updates, []);
  }
});

test("server の版は同じで protocol の版が違えば mismatch（更新しない）", async () => {
  const f = fake();
  f.helloReply = () => hello({ server_version: "0.3.1", protocol_version: "1.9.0" });
  const fl = mk(f);
  await fl.check();
  assert.equal(only(fl).state, "mismatch");
  assert.deepEqual(f.updates, []);
});

test("update_server が断られたら failed。再試行の間隔が過ぎるまで同じ版は再指示せず、過ぎたら再指示する", async () => {
  const f = fake();
  f.updateReply = () => err("版 0.3.1 を取得できない", { command: "update_server", code: "update_failed", retryable: false });
  let t = 1_000_000;
  const fl = mk(f, "0.3.1", { now: () => t, retryAfterMs: 60_000 });
  await fl.check();
  assert.equal(only(fl).state, "failed");
  assert.match(only(fl).detail, /取得できない/);
  assert.match(only(fl).detail, /1 分後に再指示/);
  t += 30_000;
  await fl.check();
  await fl.check();
  assert.equal(f.updates.length, 1);
  assert.equal(only(fl).state, "failed");
  // 間隔が過ぎたら再指示（npm に反映されていれば通る）
  t += 31_000;
  f.updateReply = () => updResult("waiting");
  await fl.check();
  assert.equal(f.updates.length, 2);
  assert.equal(only(fl).state, "updating");
});

test("hello_result.last_update が組の版の失敗なら failed。失敗時刻から間隔が過ぎたら再指示する", async () => {
  const f = fake();
  const failedAt = Date.parse("2026-10-31T00:00:00.000Z");
  f.helloReply = () => hello({ last_update: { to: "0.3.1", ok: false, error: "起動できない", at: "2026-10-31T00:00:00.000Z" } });
  let t = failedAt + 10_000;
  const fl = mk(f, "0.3.1", { now: () => t, retryAfterMs: 60_000 });
  await fl.check();
  assert.equal(only(fl).state, "failed");
  assert.match(only(fl).detail, /起動できない/);
  assert.deepEqual(f.updates, []);
  // 失敗から 1 分過ぎたら再指示（center を再起動しなくてよい）
  t = failedAt + 61_000;
  await fl.check();
  assert.equal(f.updates.length, 1);
  assert.equal(only(fl).state, "updating");
});

test("hello_result.last_update の失敗が古ければ最初の確認で再指示する（center 再起動後など）", async () => {
  const f = fake();
  f.helloReply = () => hello({ last_update: { to: "0.3.1", ok: false, error: "取得できない", at: "2026-10-31T00:00:00.000Z" } });
  const fl = mk(f, "0.3.1", { now: () => Date.parse("2026-10-31T01:00:00.000Z"), retryAfterMs: 60_000 });
  await fl.check();
  assert.equal(f.updates.length, 1);
  assert.equal(only(fl).state, "updating");
});

test("update_conflict は別の更新が進行中として updating（failed にしない）", async () => {
  const f = fake();
  f.updateReply = () => err("別の更新が進行中", { command: "update_server", code: "update_conflict", retryable: true });
  const fl = mk(f);
  await fl.check();
  assert.equal(only(fl).state, "updating");
  await fl.check();
  assert.equal(f.updates.length, 2, "failed ではないので次の周期で再確認する");
});

test("update_result current は ok", async () => {
  const f = fake();
  f.updateReply = () => updResult("current");
  const fl = mk(f);
  await fl.check();
  assert.equal(only(fl).state, "ok");
});

test("hello に答えない: unknown。ただし updating の間は updating のまま", async () => {
  const f = fake();
  f.helloReply = () => err("タイムアウト (10000ms)", { command: "hello" });
  const fl = mk(f);
  await fl.check();
  assert.equal(only(fl).state, "unknown");
  // updating にしてから応答が途切れても updating を保つ
  const g = fake();
  const gl = mk(g);
  await gl.check();
  assert.equal(only(gl).state, "updating");
  g.helloReply = () => err("タイムアウト", { command: "hello" });
  await gl.check();
  assert.equal(only(gl).state, "updating");
});

test("更新中に peer が消えても updating を保ち、戻って版が揃えば ok（peer id が変わっても同じ server）", async () => {
  const f = fake();
  const fl = mk(f);
  await fl.check();
  assert.equal(only(fl).state, "updating");
  f.peers = [];
  await fl.check();
  assert.equal(only(fl).state, "updating");
  f.peers = [peer({ id: "id-NEW" })];
  f.helloReply = () => hello({ server_version: "0.3.1" });
  await fl.check();
  const snap = fl.snapshot().peers;
  assert.equal(snap.length, 1);
  assert.equal(snap[0].state, "ok");
  assert.equal(snap[0].id, "id-NEW");
  assert.equal(snap[0].server_version, "0.3.1");
});

test("updating のまま lostAfterMs 戻らなければ lost。それ以外の server は見えなくなったら消す", async () => {
  let t = 1_000_000;
  const f = fake();
  const fl = mk(f, "0.3.1", { now: () => t, lostAfterMs: 60_000 });
  await fl.check();
  f.peers = [];
  t += 30_000;
  await fl.check();
  assert.equal(only(fl).state, "updating");
  t += 40_000;
  await fl.check();
  assert.equal(only(fl).state, "lost");

  const g = fake();
  g.helloReply = () => hello({ server_version: "0.3.1" });
  const gl = mk(g);
  await gl.check();
  g.peers = [];
  await gl.check();
  assert.deepEqual(gl.snapshot().peers, []);
});

test("発見に失敗しても状態は変えない", async () => {
  const f = fake();
  const fl = mk(f);
  await fl.check();
  f.failPeers = true;
  await fl.check();
  assert.equal(only(fl).state, "updating");
});

test("組の server 版が不明なら版合わせはせず、protocol の版だけで ok / mismatch", async () => {
  const f = fake();
  const fl = mk(f, null);
  await fl.check();
  assert.equal(only(fl).state, "ok");
  assert.deepEqual(f.updates, []);
  assert.equal(fl.snapshot().pair.server, null);
  f.helloReply = () => hello({ protocol_version: "1.9.0" });
  await fl.check();
  assert.equal(only(fl).state, "mismatch");
});

test("gate: updating の server への kick_cap / task だけ、再送可の error で断る", async () => {
  const f = fake();
  const fl = mk(f);
  assert.equal(fl.gate({ id: "id-1" }, "kick_cap"), undefined, "まだ何も分かっていない間は通す");
  await fl.check();
  const g = fl.gate({ id: "id-1" }, "kick_cap");
  assert.equal(g?.code, "updating");
  assert.equal(g?.retryable, true);
  assert.equal(g?.command, "kick_cap");
  assert.equal(fl.gate({ id: "id-1" }, "task")?.code, "updating");
  assert.equal(fl.gate({ id: "id-1" }, "task")?.command, "task");
  assert.match(g?.message ?? "", /0\.3\.0→0\.3\.1/);
  assert.match(g?.message ?? "", /再送/);
  for (const c of ["stop_cap", "status", "hello", "update_server", "worker_reply"] as const) assert.equal(fl.gate({ id: "id-1" }, c), undefined, c);
  assert.equal(fl.gate({ id: "other" }, "kick_cap"), undefined);
});

test("同時に 2 周は走らない", async () => {
  const f = fake();
  const fl = mk(f);
  await Promise.all([fl.check(), fl.check(), fl.check()]);
  assert.equal(f.hellos.length, 1);
});

test("複数 server はそれぞれ独立に扱う", async () => {
  const f = fake();
  f.peers = [peer(), peer({ id: "id-2", summary: "host2 /ws", hostname: "host2" })];
  f.helloReply = (p) => (p.id === "id-2" ? hello({ server_version: "0.3.1" }) : hello());
  const fl = mk(f);
  await fl.check();
  const states = Object.fromEntries(fl.snapshot().peers.map((e) => [e.id, e.state]));
  assert.deepEqual(states, { "id-1": "updating", "id-2": "ok" });
  assert.deepEqual(f.updates, [["id-1", "0.3.1"]]);
});

test("noteOf: 更新を指示済みの server は、待っている cap / worker の件数と更新先・いつからを文に出す", async () => {
  const f = fake();
  let t = Date.parse("2026-01-01T00:00:00Z");
  const fl = mk(f, "0.3.1", { now: () => t });
  await fl.check();
  const note = fl.noteOf({ id: "id-1" });
  assert.match(note, /更新を指示済み/);
  assert.match(note, /cap 1 \/ worker 2/);
  assert.match(note, /0\.3\.0→0\.3\.1/);
  assert.match(note, /2026-01-01T00:00:00\.000Z/);
});

test("noteOf: 更新に失敗した server は、直近の失敗の内容を文に出す", async () => {
  const f = fake();
  f.updateReply = () => err("npm に 0.3.1 が無い");
  const fl = mk(f);
  await fl.check();
  const note = fl.noteOf({ id: "id-1" });
  assert.match(note, /更新に失敗/);
  assert.match(note, /npm に 0\.3\.1 が無い/);
});

test("noteOf: まだ確かめていない peer は『未確認』", () => {
  const fl = mk(fake());
  assert.match(fl.noteOf({ id: "id-zzz" }), /未確認/);
});

test("versionOf: center の版・server の版・更新の状態を返す。server_id（無ければ peer id）で引き、別の server は引かない。detail は 200 文字に切る", async () => {
  const f = fake();
  f.updateReply = () => err("x".repeat(500));
  const fl = mk(f);
  await fl.check();
  const i = fl.versionOf({ peer: "id-1" })!;
  assert.equal(i.center_protocol, PV);
  assert.equal(i.server_version, "0.3.0");
  assert.equal(i.state, "failed");
  assert.ok(i.detail.length <= 200);
  assert.equal(fl.versionOf({ peer: "id-other" }), undefined);
  assert.equal(fl.versionOf({ server_id: "nope" }), undefined);
});

test("updating: server が返す待ちの中身（run・session・経過・上限）を detail・versionOf・gate の error に出す", async () => {
  const f = fake();
  const t = Date.parse("2026-11-21T05:22:00.000Z");
  const fl = mk(f, "0.3.1", {
    now: () => t,
    sessionOfCap: (cid) => (cid.startsWith("c-0123456789-") ? cid.slice("c-0123456789-".length) : undefined),
  });
  f.helloReply = () =>
    hello({
      update: {
        state: "waiting",
        from: "0.3.0",
        to: "0.3.1",
        running: { caps: 1, workers: 1, reports: 0 },
        since: "2026-11-21T05:10:00.000Z",
        deadline: "2026-11-21T05:40:00.000Z",
        runs: [
          { kind: "cap", id: "c-0123456789-mflow", started_at: "2026-11-21T05:14:00.000Z", phase: "running" },
          { kind: "worker", id: "w-1", cap_id: "c-9999999999-x", started_at: "2026-11-21T05:19:00.000Z", phase: "running" },
        ],
      },
    });
  await fl.check();
  const e = only(fl);
  assert.equal(e.state, "updating");
  assert.match(e.detail, /cap 1 \/ worker 1/);
  assert.match(e.detail, /session mflow の cap 実行 8 分/);
  assert.match(e.detail, /cap c-9999999999-x の worker w-1 実行 3 分/);
  assert.match(e.detail, /待機 12 分/);
  assert.match(e.detail, /2026-11-21T05:40:00\.000Z（上限）/);
  const info = fl.versionOf({ peer: "id-1" });
  assert.equal(info?.update?.since, "2026-11-21T05:10:00.000Z");
  assert.equal(info?.update?.deadline, "2026-11-21T05:40:00.000Z");
  assert.deepEqual(info?.update?.runs?.map((r) => `${r.kind}:${r.id}:${r.session ?? "-"}`), ["cap:c-0123456789-mflow:mflow", "worker:w-1:-"]);
  const g = fl.gate({ id: "id-1" }, "task");
  assert.equal(g?.code, "updating");
  assert.match(g?.message ?? "", /^server 更新待ち（0\.3\.0→0\.3\.1）。.*再送。待機 12 分、2026-11-21T05:40:00\.000Z（上限）に残りを止めて再起動。待っている run: cap 1 \/ worker 1（session mflow の cap 実行 8 分/);
  assert.equal(g?.update?.runs?.length, 2);
  assert.equal(g?.update?.deadline, "2026-11-21T05:40:00.000Z");
});

test("updating: 旧 server（件数だけ）でも gate の error に件数と updating になった時刻を出す", async () => {
  const f = fake();
  const fl = mk(f);
  await fl.check();
  const g = fl.gate({ id: "id-1" }, "kick_cap");
  assert.match(g?.message ?? "", /待っている run: cap 1 \/ worker 2/);
  // update_conflict は待ちの中身が無い: detail と時刻を出す
  const f2 = fake();
  f2.updateReply = () => err("別の更新が進行中（0.3.0 -> 0.3.2）", { code: "update_conflict", retryable: true });
  const fl2 = mk(f2);
  await fl2.check();
  assert.match(fl2.gate({ id: "id-1" }, "task")?.message ?? "", /別の更新が進行中.*から）$/);
});

test("updating のまま発見に残る server が hello に答えなければ、lostAfterMs 後に lost にして断るのをやめる", async () => {
  const f = fake();
  let t = 0;
  const fl = mk(f, "0.3.1", { now: () => t, lostAfterMs: 60_000 });
  await fl.check();
  assert.equal(only(fl).state, "updating");
  f.helloReply = () => err("応答なし");
  t = 30_000;
  await fl.check();
  assert.equal(only(fl).state, "updating");
  assert.equal(fl.gate({ id: "id-1" }, "task")?.code, "updating");
  t = 61_000;
  await fl.check();
  assert.equal(only(fl).state, "lost");
  assert.equal(fl.gate({ id: "id-1" }, "task"), undefined);
});

test("updating の detail は経過と上限を先に書く（versionOf の 200 字で切っても残る）", async () => {
  const f = fake();
  const t = Date.parse("2026-11-21T05:22:00.000Z");
  const fl = mk(f, "0.3.1", { now: () => t });
  const runs = Array.from({ length: 12 }, (_, i) => ({ kind: "worker" as const, id: `w-long-worker-id-${i}-xxxxxxxxxxxx`, cap_id: `c-0123456789-session-${i}`, started_at: "2026-11-21T05:19:00.000Z", phase: "running" as const }));
  f.helloReply = () =>
    hello({ update: { state: "waiting", from: "0.3.0", to: "0.3.1", running: { caps: 0, workers: 12, reports: 0 }, since: "2026-11-21T05:10:00.000Z", deadline: "2026-11-21T05:40:00.000Z", runs } });
  await fl.check();
  const d = fl.versionOf({ peer: "id-1" })!.detail;
  assert.ok(d.length <= 200);
  assert.match(d, /^更新中（0\.3\.0→0\.3\.1）: 待機 12 分、2026-11-21T05:40:00\.000Z（上限）に残りを止めて再起動。待っている run: cap 0 \/ worker 12/);
});

test("lost は最後に hello に答えた時刻から測る: 長く正常に待った server を、再起動中の無応答 1 回で lost にしない", async () => {
  const f = fake();
  let t = 0;
  const fl = mk(f, "0.3.1", { now: () => t, lostAfterMs: 60_000 });
  f.helloReply = () => hello({ update: { state: "waiting", from: "0.3.0", to: "0.3.1", running } });
  await fl.check();
  assert.equal(only(fl).state, "updating");
  // 3 分間、待機中として答え続ける（updating になってからは lostAfterMs を越える）
  for (t = 30_000; t <= 180_000; t += 30_000) await fl.check();
  // 再起動中: hello に答えない。最後の答え（180 秒）から 60 秒以内は updating のまま断り続ける
  f.helloReply = () => err("応答なし");
  t = 200_000;
  await fl.check();
  assert.equal(only(fl).state, "updating");
  assert.equal(fl.gate({ id: "id-1" }, "task")?.code, "updating");
  // 発見から消えた間も同じ（lostCheck）
  f.peers = [];
  t = 230_000;
  await fl.check();
  assert.equal(fl.snapshot().peers[0]?.state, "updating");
  t = 241_000;
  await fl.check();
  assert.equal(fl.snapshot().peers[0]?.state, "lost");
});
