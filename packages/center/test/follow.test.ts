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

function mk(f: Fake, pairServer: string | null = "0.3.1", extra: { now?: () => number; lostAfterMs?: number } = {}): Follow {
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

test("update_server が断られたら failed で、同じ版は center が再起動するまで再指示しない", async () => {
  const f = fake();
  f.updateReply = () => err("版 0.3.1 を取得できない", { command: "update_server", code: "update_failed", retryable: false });
  const fl = mk(f);
  await fl.check();
  assert.equal(only(fl).state, "failed");
  assert.match(only(fl).detail, /取得できない/);
  await fl.check();
  await fl.check();
  assert.equal(f.updates.length, 1);
  assert.equal(only(fl).state, "failed");
});

test("hello_result.last_update が組の版の失敗なら failed（指示しない）", async () => {
  const f = fake();
  f.helloReply = () => hello({ last_update: { to: "0.3.1", ok: false, error: "起動できない", at: "2026-10-31T00:00:00.000Z" } });
  const fl = mk(f);
  await fl.check();
  assert.equal(only(fl).state, "failed");
  assert.match(only(fl).detail, /起動できない/);
  assert.deepEqual(f.updates, []);
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

test("gate: updating の server への kick_cap だけ、再送可の error で断る", async () => {
  const f = fake();
  const fl = mk(f);
  assert.equal(fl.gate({ id: "id-1" }, "kick_cap"), undefined, "まだ何も分かっていない間は通す");
  await fl.check();
  const g = fl.gate({ id: "id-1" }, "kick_cap");
  assert.equal(g?.code, "updating");
  assert.equal(g?.retryable, true);
  assert.equal(g?.command, "kick_cap");
  assert.match(g?.message ?? "", /0\.3\.0→0\.3\.1/);
  assert.match(g?.message ?? "", /再送/);
  for (const c of ["stop_cap", "status", "hello", "update_server"] as const) assert.equal(fl.gate({ id: "id-1" }, c), undefined, c);
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
