import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { parseConfig, type Config, type ProjectConfig } from "../src/config.js";
import { createEventHub, type SessionsEvent } from "../src/events.js";
import type { RcStatus, RemoteControlSupervisor } from "../src/remote-control.js";
import { createSessionManager, type SavedSession } from "../src/sessions.js";
import { createSleepGate } from "../src/sleep-gate.js";
import type { LinkClient, LinkInbound, PeerMark } from "../src/server-link.js";
import { createJsonListStore } from "../src/store.js";

/** supervisor の偽物（stop を持つ）。 */
function fakeSupervisor(initial: ProjectConfig[]) {
  const map = new Map<string, RcStatus>();
  const calls: string[] = [];
  const mk = (p: ProjectConfig): RcStatus => ({
    project: p.name, path: p.path, state: "stopped", pid: null, sessionUrl: null, environmentUrl: null,
    restarts: 0, lastExit: null, startedAt: null, args: null, instructions: false, claude: { path: "claude", source: "PATH" },
    auth: "ok", loginUrl: null, loginError: null,
  });
  for (const p of initial) map.set(p.name, mk(p));
  const sup = {
    add: (p: ProjectConfig) => {
      calls.push(`add:${p.name}`);
      map.set(p.name, mk(p));
    },
    remove: async (n: string) => {
      calls.push(`remove:${n}`);
      map.delete(n);
    },
    start: async (n: string, o?: { resume?: boolean }) => {
      calls.push(`start:${n}${o?.resume ? ":resume" : ""}`);
      const s = map.get(n)!;
      s.state = "connected";
      s.pid = 4242;
      s.sessionUrl = `https://claude.ai/code/session_${n}`;
      return { ...s };
    },
    stop: async (n: string) => {
      calls.push(`stop:${n}`);
      const s = map.get(n)!;
      s.state = "stopped";
      s.pid = null;
      return { ...s };
    },
    setInstructions: () => {},
    setAddDirs: () => {},
    setOutputStyle: () => {},
    setMemory: () => {},
    status: (n: string) => ({ ...map.get(n)! }),
    list: () => [...map.values()].map((s) => ({ ...s })),
  } as unknown as RemoteControlSupervisor;
  return { sup, calls, map };
}

let dir: string;
let config: Config;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "center-sleep-"));
  config = parseConfig({ workspace: join(dir, "ws"), projects: [{ name: "cfg", path: join(dir, "cfgproj") }] }, join(dir, "c.json"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const setup = (extra: Partial<Parameters<typeof createSessionManager>[0]> = {}) => {
  const fs = fakeSupervisor(config.projects);
  const store = createJsonListStore<SavedSession>(join(dir, "sessions.json"), () => {});
  const events = createEventHub();
  const seen: SessionsEvent[] = [];
  events.subscribe((e) => seen.push(e));
  const changes: string[] = [];
  const mgr = createSessionManager({
    config, supervisor: fs.sup, store, log: () => {}, waitMs: 0, events,
    onSleepChange: (n, s) => changes.push(`${n}:${s}`),
    ...extra,
  });
  return { ...fs, store, mgr, seen, changes };
};
const savedOf = async (): Promise<SavedSession[]> => JSON.parse(await readFile(join(dir, "sessions.json"), "utf8")) as SavedSession[];

test("sleep: claude を止め（stop）、sleeping を保存し、一覧は state=stopped・sleeping=true。event と身代わり通知が出る。remove はしない（記録は残る）", async () => {
  const { mgr, calls, seen, changes } = setup();
  await mgr.create({ name: "pm1" });
  const r = await mgr.sleep("pm1");
  assert.equal(r.state, "stopped");
  assert.equal(r.sleeping, true);
  assert.deepEqual(calls, ["add:pm1", "start:pm1", "stop:pm1"]);
  assert.equal(mgr.list().find((s) => s.name === "pm1")?.sleeping, true);
  assert.equal((await savedOf())[0].sleeping, true);
  assert.ok(seen.some((e) => e.reason === "sleep" && e.name === "pm1"));
  assert.deepEqual(changes, ["pm1:true"]);
  // 起きていない他の session は sleeping でない
  assert.equal(mgr.list().find((s) => s.name === "cfg")?.sleeping, false);
});

test("sleep: 眠っている session にもう一度 sleep しても何もしない（stop は 1 回）", async () => {
  const { mgr, calls } = setup();
  await mgr.create({ name: "pm1" });
  await mgr.sleep("pm1");
  await mgr.sleep("pm1");
  assert.equal(calls.filter((c) => c === "stop:pm1").length, 1);
});

test("sleep / wake: config 由来・未定義の session は error", async () => {
  const { mgr } = setup();
  await assert.rejects(() => mgr.sleep("cfg"), /config 由来/);
  await assert.rejects(() => mgr.sleep("nope"), /未定義の session: nope/);
  await assert.rejects(() => mgr.wake("nope"), /未定義の session: nope/);
});

test("wake: スリープを解いて --continue（resume）で起動し直す。保存・event・身代わり解除の通知が出る", async () => {
  const { mgr, calls, seen, changes } = setup();
  await mgr.create({ name: "pm1" });
  await mgr.sleep("pm1");
  const r = await mgr.wake("pm1");
  assert.equal(r.sleeping, false);
  assert.equal(r.state, "connected");
  assert.deepEqual(calls, ["add:pm1", "start:pm1", "stop:pm1", "start:pm1:resume"]);
  assert.equal((await savedOf())[0].sleeping, undefined);
  assert.deepEqual(changes, ["pm1:true", "pm1:false"]);
  assert.equal(seen.filter((e) => e.reason === "sleep").length, 2);
});

test("wake: supervisor.start が失敗したら、眠ったままに戻す（sleeping を保存、身代わりを置き直す通知、エラーを返す）", async () => {
  const { mgr, sup, changes } = setup();
  await mgr.create({ name: "pm1" });
  await mgr.sleep("pm1");
  let fail = true;
  const realStart = sup.start;
  (sup as unknown as { start: unknown }).start = async (n: string, o?: { resume?: boolean }) => {
    if (fail) throw new Error("start 失敗");
    return realStart.call(sup, n, o);
  };
  await assert.rejects(() => mgr.wake("pm1"), /start 失敗/);
  assert.equal(mgr.list().find((s) => s.name === "pm1")?.sleeping, true);
  assert.equal((await savedOf())[0].sleeping, true);
  assert.deepEqual(changes, ["pm1:true", "pm1:false", "pm1:true"]);
  fail = false;
  const r = await mgr.wake("pm1");
  assert.equal(r.sleeping, false);
});

test("wake: 眠っていない session には何もしない（start しない）", async () => {
  const { mgr, calls } = setup();
  await mgr.create({ name: "pm1" });
  const r = await mgr.wake("pm1");
  assert.equal(r.state, "connected");
  assert.deepEqual(calls, ["add:pm1", "start:pm1"]);
});

test("restore: 眠っていた session は起動せず眠ったまま復帰し、身代わりの通知が出る。眠っていない session は --continue で復帰する", async () => {
  const mk = (name: string, sleeping?: boolean): SavedSession => ({ name, path: join(dir, name), permissionMode: "auto", createdAt: "2026-11-21T00:00:00Z", ...(sleeping ? { sleeping } : {}) });
  await writeFile(join(dir, "sessions.json"), JSON.stringify([mk("zzz", true), mk("awake")]));
  const { mgr, calls, changes } = setup();
  await mgr.restore();
  assert.deepEqual(calls, ["add:zzz", "add:awake", "start:awake:resume"]);
  assert.deepEqual(changes, ["zzz:true"]);
  const l = mgr.list();
  assert.equal(l.find((s) => s.name === "zzz")?.sleeping, true);
  assert.equal(l.find((s) => s.name === "zzz")?.state, "stopped");
  assert.equal(l.find((s) => s.name === "awake")?.sleeping, false);
});

const savedMk = (name: string, sleeping?: boolean): SavedSession => ({ name, path: join(dir, name), permissionMode: "auto", createdAt: "2026-11-21T00:00:00Z", ...(sleeping ? { sleeping } : {}) });

test("restore: onRestoreStart は非スリープ・成功の session にだけ、supervisor.start(resume) の直前に呼ぶ（T15・T2）", async () => {
  await writeFile(join(dir, "sessions.json"), JSON.stringify([savedMk("zzz", true), savedMk("awake")]));
  const order: string[] = [];
  const { mgr, sup } = setup({ onRestoreStart: (n) => order.push(`arm:${n}`), onRestoreFail: (n) => order.push(`fail:${n}`) });
  const realStart = sup.start;
  (sup as unknown as { start: unknown }).start = async (n: string, o?: { resume?: boolean }) => {
    order.push(`start:${n}${o?.resume ? ":resume" : ""}`);
    return realStart.call(sup, n, o);
  };
  await mgr.restore();
  assert.deepEqual(order, ["arm:awake", "start:awake:resume"]);
});

test("restore: スリープ中の session は wake しても onRestoreStart を呼ばない。新規・sleep→wake でも呼ばない（T2）", async () => {
  await writeFile(join(dir, "sessions.json"), JSON.stringify([savedMk("zzz", true)]));
  const armed: string[] = [];
  const { mgr } = setup({ onRestoreStart: (n) => armed.push(n) });
  await mgr.restore();
  await mgr.wake("zzz");
  await mgr.create({ name: "fresh" });
  await mgr.sleep("fresh");
  await mgr.wake("fresh");
  assert.deepEqual(armed, []);
});

test("restore: supervisor.start が投げたら onRestoreFail を呼び、次の session へ進む。成功した session には呼ばない（T9）", async () => {
  await writeFile(join(dir, "sessions.json"), JSON.stringify([savedMk("bad"), savedMk("good")]));
  const order: string[] = [];
  const { mgr, sup } = setup({ onRestoreStart: (n) => order.push(`arm:${n}`), onRestoreFail: (n) => order.push(`fail:${n}`) });
  const realStart = sup.start;
  (sup as unknown as { start: unknown }).start = async (n: string, o?: { resume?: boolean }) => {
    if (n === "bad") throw new Error("start 失敗");
    return realStart.call(sup, n, o);
  };
  await mgr.restore();
  assert.deepEqual(order, ["arm:bad", "fail:bad", "arm:good"]);
});

test("update（名前の変更）は止めて起動し直す操作なので、眠っていた session も起きる", async () => {
  const { mgr, calls, changes } = setup();
  await mgr.create({ name: "pm1" });
  await mgr.sleep("pm1");
  const r = await mgr.update({ name: "pm1", newName: "pm2" });
  assert.equal(r.sleeping, false);
  assert.equal(r.state, "connected");
  assert.ok(calls.includes("start:pm2:resume"));
  assert.equal((await savedOf())[0].sleeping, undefined);
  assert.deepEqual(changes, ["pm1:true", "pm1:false"]);
});

test("delete: 眠っている session を消すと身代わりが外れる", async () => {
  const { mgr, changes } = setup();
  await mgr.create({ name: "pm1" });
  await mgr.sleep("pm1");
  await mgr.delete("pm1");
  assert.deepEqual(changes, ["pm1:true", "pm1:false"]);
});

// ---- 身代わり peer（sleep-gate.ts） ----

function fakeClient(opts: { failConnect?: () => boolean } = {}) {
  const handlers: ((m: LinkInbound) => void | Promise<void>)[] = [];
  const state = { connected: false, closed: false };
  const client = {
    connect: async () => {
      if (opts.failConnect?.()) throw new Error("broker に繋がらない");
      state.connected = true;
    },
    close: async () => {
      state.closed = true;
    },
    send: async () => ({}),
    onMessage: (h: (m: LinkInbound) => void | Promise<void>) => {
      handlers.push(h);
      return () => {};
    },
    peer: { id: "standin-1" },
  } as unknown as LinkClient;
  return { client, state, emit: (m: LinkInbound) => handlers.forEach((h) => void h(m)) };
}
const tick = (ms = 20): Promise<void> => new Promise((r) => setTimeout(r, ms));

test("gate: 眠った session に身代わりを置き（名前=peerName）、宛先になったら 身代わりを外す → wake → 起きた peer へ元の送り手付きで渡す", async () => {
  const made: { name: string; fc: ReturnType<typeof fakeClient> }[] = [];
  const order: string[] = [];
  const delivered: { name: string; text: string }[] = [];
  const gate = createSleepGate({
    clientFactory: (n) => {
      const fc = fakeClient();
      made.push({ name: n, fc });
      return fc.client;
    },
    wake: async (n) => {
      order.push(`wake:${n}:standin-closed=${made[0].fc.state.closed}`);
    },
    deliver: async (n, t) => {
      order.push("deliver");
      delivered.push({ name: n, text: t });
      return { ok: true };
    },
    peerName: (n) => `${n}-cap`,
    log: () => {},
    deliverIntervalMs: 5,
  });
  gate.sync("pm1", true);
  await tick();
  assert.deepEqual(made.map((m) => m.name), ["pm1-cap"]);
  assert.equal(made[0].fc.state.connected, true);
  assert.deepEqual(gate.standingIn(), ["pm1"]);
  made[0].fc.emit({ from_name: "worker-x", text: "進捗です", mode: "push" });
  await tick(50);
  // 身代わりを外してから起こす。その後に渡す
  assert.deepEqual(order, ["wake:pm1:standin-closed=true", "deliver"]);
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].name, "pm1");
  assert.match(delivered[0].text, /worker-x/);
  assert.match(delivered[0].text, /進捗です/);
  assert.deepEqual(gate.standingIn(), []);
  await gate.close();
});

test("gate: 起きた claude の peer がまだ居ない間は渡しを再試行し、現れたら渡す。起こす間に届いた 2 通目も束ねて渡す", async () => {
  const fc = fakeClient();
  let attempts = 0;
  const delivered: string[] = [];
  let wakeResolve!: () => void;
  const wakeGate = new Promise<void>((r) => (wakeResolve = r));
  const gate = createSleepGate({
    clientFactory: () => fc.client,
    wake: async () => wakeGate,
    deliver: async (_n, t) => {
      attempts++;
      if (attempts < 3) return { ok: false, reason: "peer が居ない" };
      delivered.push(t);
      return { ok: true };
    },
    peerName: (n) => `${n}-cap`,
    log: () => {},
    deliverIntervalMs: 5,
  });
  gate.sync("pm1", true);
  await tick();
  fc.emit({ from_name: "a", text: "one" });
  fc.emit({ from_name: "b", text: "two" });
  await tick();
  wakeResolve();
  await tick(100);
  assert.equal(delivered.length, 2);
  assert.match(delivered[0], /one/);
  assert.match(delivered[1], /two/);
  await gate.close();
});

test("gate: 起きた（sync false）・center の終了（close）で身代わりが外れる。眠っていない session には置かない", async () => {
  const clients: ReturnType<typeof fakeClient>[] = [];
  const gate = createSleepGate({
    clientFactory: () => {
      const fc = fakeClient();
      clients.push(fc);
      return fc.client;
    },
    wake: async () => {},
    deliver: async () => ({ ok: true }),
    peerName: (n) => `${n}-cap`,
    log: () => {},
  });
  gate.sync("awake", false);
  assert.equal(clients.length, 0);
  gate.sync("a", true);
  gate.sync("b", true);
  gate.sync("a", true); // 二重に置かない
  await tick();
  assert.equal(clients.length, 2);
  gate.sync("a", false);
  await tick();
  assert.equal(clients[0].state.closed, true);
  assert.equal(clients[1].state.closed, false);
  await gate.close();
  assert.equal(clients[1].state.closed, true);
  assert.deepEqual(gate.standingIn(), []);
});

test("gate: broker に繋がらない間は再試行し、繋がったら身代わりを置く。外した後は再試行しない", async () => {
  let fail = true;
  const clients: ReturnType<typeof fakeClient>[] = [];
  const gate = createSleepGate({
    clientFactory: () => {
      const fc = fakeClient({ failConnect: () => fail });
      clients.push(fc);
      return fc.client;
    },
    wake: async () => {},
    deliver: async () => ({ ok: true }),
    peerName: (n) => `${n}-cap`,
    log: () => {},
    retryMs: 10,
  });
  gate.sync("pm1", true);
  await tick(35);
  assert.ok(clients.length >= 2);
  assert.ok(clients.every((c) => !c.state.connected));
  fail = false;
  await tick(40);
  assert.ok(clients.some((c) => c.state.connected));
  const n = clients.length;
  gate.sync("pm1", false);
  await tick(40);
  assert.equal(clients.length, n);
  await gate.close();
});

test("gate: 起こせなかった時、まだ眠っているなら身代わりを置き直す", async () => {
  let made = 0;
  let sleeping = true;
  const fcs: ReturnType<typeof fakeClient>[] = [];
  const gate = createSleepGate({
    clientFactory: () => {
      made++;
      const fc = fakeClient();
      fcs.push(fc);
      return fc.client;
    },
    wake: async () => {
      throw new Error("start 失敗");
    },
    deliver: async () => ({ ok: true }),
    isSleeping: () => sleeping,
    peerName: (n) => `${n}-cap`,
    log: () => {},
  });
  gate.sync("pm1", true);
  await tick();
  fcs[0].emit({ from_name: "a", text: "x" });
  await tick(50);
  assert.equal(made, 2);
  assert.deepEqual(gate.standingIn(), ["pm1"]);
  sleeping = false;
  await gate.close();
});

// ---- review 指摘（古い同名 peer・stop 失敗・pending の引き継ぎ） ----

test("gate: 起床前から居た古い同名 peer（眠らせた claude の登録が broker に残る）へは渡さない。新しい claude の peer が現れてから渡す", async () => {
  const fc = fakeClient();
  // broker の模擬: 起こす前は古い peer old-1 だけ。起床の少し後に新しい claude の peer new-1 が登録される
  const brokerPeers = ["old-1"];
  const sentTo: string[] = [];
  const mark = { exclude: new Set(["old-1"]), since: "2026-11-21T00:00:00.000Z" };
  let polls = 0;
  const gate = createSleepGate({
    clientFactory: () => fc.client,
    peerMark: async () => mark,
    wake: async () => {},
    deliver: async (_n, _t, m) => {
      polls++;
      if (polls === 3) brokerPeers.push("new-1");
      const hit = brokerPeers.filter((id) => !m?.exclude.has(id)).pop();
      if (!hit) return { ok: false, reason: "peer が居ない" };
      sentTo.push(hit);
      return { ok: true };
    },
    peerName: (n) => `${n}-cap`,
    log: () => {},
    deliverIntervalMs: 5,
  });
  gate.sync("pm1", true);
  await tick();
  fc.emit({ from_name: "a", text: "x" });
  await tick(100);
  assert.deepEqual(sentTo, ["new-1"]);
  assert.ok(polls >= 3);
  await gate.close();
});

test("gate: 起こせなかった時、溜まっていた message は捨てず、置き直した身代わりへ引き継ぎ、次に起きた時に渡す", async () => {
  const fcs: ReturnType<typeof fakeClient>[] = [];
  let failWake = true;
  const delivered: string[] = [];
  const gate = createSleepGate({
    clientFactory: () => {
      const fc = fakeClient();
      fcs.push(fc);
      return fc.client;
    },
    wake: async () => {
      if (failWake) throw new Error("start 失敗");
    },
    deliver: async (_n, t) => {
      delivered.push(t);
      return { ok: true };
    },
    isSleeping: () => true,
    peerName: (n) => `${n}-cap`,
    log: () => {},
    deliverIntervalMs: 5,
  });
  gate.sync("pm1", true);
  await tick();
  fcs[0].emit({ from_name: "a", text: "first" });
  await tick(50);
  assert.equal(fcs.length, 2); // 置き直し
  assert.deepEqual(delivered, []);
  failWake = false;
  fcs[1].emit({ from_name: "b", text: "second" });
  await tick(100);
  assert.equal(delivered.length, 2);
  assert.match(delivered[0], /first/);
  assert.match(delivered[1], /second/);
  await gate.close();
});

test("gate: message 無しで起きた（desktop で開く等）時、身代わりが預かっていた message があれば起きた claude へ渡す（起床前の古い peer は除く）", async () => {
  const fcs: ReturnType<typeof fakeClient>[] = [];
  let failWake = true;
  const marks: (PeerMark | undefined)[] = [];
  const delivered: string[] = [];
  const gate = createSleepGate({
    clientFactory: () => {
      const fc = fakeClient();
      fcs.push(fc);
      return fc.client;
    },
    peerMark: async () => ({ exclude: new Set(["old-1"]), since: "2026-11-21T00:00:00.000Z" }),
    wake: async () => {
      if (failWake) throw new Error("start 失敗");
    },
    deliver: async (_n, t, m) => {
      marks.push(m);
      delivered.push(t);
      return { ok: true };
    },
    isSleeping: () => true,
    peerName: (n) => `${n}-cap`,
    log: () => {},
    deliverIntervalMs: 5,
  });
  gate.sync("pm1", true);
  await tick();
  fcs[0].emit({ from_name: "a", text: "kept" });
  await tick(50);
  failWake = false;
  gate.sync("pm1", false); // sessions.wake が呼ぶ
  await tick(100);
  assert.equal(delivered.length, 1);
  assert.match(delivered[0], /kept/);
  assert.ok(marks[0]?.exclude.has("old-1"));
  assert.equal(marks[0]?.since, "2026-11-21T00:00:00.000Z");
  await gate.close();
});

test("sleep: supervisor.stop が失敗したら、眠った事にしない（sleeping を戻して保存、身代わり通知なし、エラーを返す）", async () => {
  const { mgr, sup, changes } = setup();
  await mgr.create({ name: "pm1" });
  (sup as unknown as { stop: () => Promise<never> }).stop = async () => {
    throw new Error("stop できない");
  };
  await assert.rejects(mgr.sleep("pm1"), /stop できない/);
  assert.deepEqual(changes, []);
  assert.equal(mgr.list().find((s) => s.name === "pm1")?.sleeping, false);
  assert.notEqual((await savedOf())[0].sleeping, true);
});

test("gate: 新しい claude の peer が上限（deliverTimeoutMs）まで現れなかった時は、渡せなかった事を log に出し、message の全文（送り手・本文）を log に残す（捨てない）", async () => {
  const fc = fakeClient();
  const logs: string[] = [];
  const gate = createSleepGate({
    clientFactory: () => fc.client,
    wake: async () => {},
    deliver: async () => ({ ok: false, reason: "古い peer しか居ない" }),
    peerName: (n) => `${n}-cap`,
    log: (m) => logs.push(m),
    deliverIntervalMs: 5,
    deliverTimeoutMs: 40,
  });
  gate.sync("pm1", true);
  await tick();
  fc.emit({ from_name: "worker-x", text: "大事な連絡です" });
  await tick(150);
  const l = logs.find((x) => x.includes("渡せなかった"));
  assert.ok(l, "log に出る");
  assert.match(l!, /worker-x/);
  assert.match(l!, /大事な連絡です/);
  assert.match(l!, /古い peer しか居ない/);
  await gate.close();
});

test("gate: 起こせず、もう眠っていない時は、溜まっていた message の全文（送り手・本文）を log に残す", async () => {
  const logs: string[] = [];
  const fcs: ReturnType<typeof fakeClient>[] = [];
  const gate = createSleepGate({
    clientFactory: () => {
      const fc = fakeClient();
      fcs.push(fc);
      return fc.client;
    },
    wake: async () => {
      throw new Error("start 失敗");
    },
    deliver: async () => ({ ok: true }),
    isSleeping: () => false,
    peerName: (n) => `${n}-cap`,
    log: (m) => logs.push(m),
  });
  gate.sync("pm1", true);
  await tick();
  fcs[0].emit({ from_name: "a", text: "本文その1" });
  await tick(50);
  assert.ok(logs.some((l) => l.includes("渡せなかった message") && l.includes("from=a") && l.includes("本文その1")));
  await gate.close();
});

test("gate: 他の経路で起きる時、身代わりが外れる間（close 中）に出し切られた message も捨てず、起きた claude へ渡す", async () => {
  const fcs: ReturnType<typeof fakeClient>[] = [];
  const delivered: string[] = [];
  const gate = createSleepGate({
    clientFactory: () => {
      const fc = fakeClient();
      const close = fc.client.close.bind(fc.client);
      // 身代わりは止まる前に mailbox の残りを出し切る。close の間に 2 通が handler へ届く
      fc.client.close = async () => {
        fc.emit({ from_name: "a", text: "drained-1" });
        fc.emit({ from_name: "a", text: "drained-2" });
        await close();
      };
      fcs.push(fc);
      return fc.client;
    },
    wake: async () => {},
    deliver: async (_n, t) => {
      delivered.push(t);
      return { ok: true };
    },
    isSleeping: () => true,
    peerName: (n) => `${n}-cap`,
    log: () => {},
    deliverIntervalMs: 5,
  });
  gate.sync("pm1", true);
  await tick();
  gate.sync("pm1", false); // message を受けずに起きる（desktop で開く・wake）
  await tick(100);
  assert.equal(fcs[0].state.closed, true);
  assert.equal(delivered.length, 2);
  assert.match(delivered[0], /drained-1/);
  assert.match(delivered[1], /drained-2/);
  await gate.close();
});

// ---- 引継ぎつきの眠り（docs/design/sleep-resession.md の I1・T7〜T11） ----

const REF = { id: "c1:handoff-1", stored: "memory" as const };

/** onWake / onWakeAbort を記録する setup。onWake の時点までに supervisor に来ていた呼びも残す（起動の前に呼ぶ事の確認）。 */
const setupWake = () => {
  const wakes: { name: string; ref: unknown; callsBefore: string[] }[] = [];
  const aborts: string[] = [];
  let callsRef: string[] = [];
  const s = setup({
    onWake: (name, ref) => void wakes.push({ name, ref, callsBefore: [...callsRef] }),
    onWakeAbort: (name) => void aborts.push(name),
  });
  callsRef = s.calls;
  return { ...s, wakes, aborts };
};

test("T1: sleep(handoff) は sleeping と sleepHandoff を保存して止める", async () => {
  const { mgr, calls } = setupWake();
  await mgr.create({ name: "pm1" });
  await mgr.sleep("pm1", { handoff: REF });
  assert.deepEqual(calls, ["add:pm1", "start:pm1", "stop:pm1"]);
  const rec = (await savedOf())[0];
  assert.equal(rec.sleeping, true);
  assert.deepEqual(rec.sleepHandoff, REF);

});

test("sleep(handoff): supervisor.stop が失敗したら、sleeping も sleepHandoff も戻して保存する", async () => {
  const { mgr, sup } = setupWake();
  await mgr.create({ name: "pm1" });
  (sup as unknown as { stop: () => Promise<never> }).stop = async () => {
    throw new Error("stop できない");
  };
  await assert.rejects(mgr.sleep("pm1", { handoff: REF }), /stop できない/);
  const rec = (await savedOf())[0];
  assert.notEqual(rec.sleeping, true);
  assert.equal(rec.sleepHandoff, undefined);
});

test("sleep(handoff 無し) は前の（渡し終えていない）参照を引き継がない", async () => {
  const { mgr } = setupWake();
  await mgr.create({ name: "pm1" });
  await mgr.sleep("pm1", { handoff: REF });
  await mgr.wake("pm1");
  // 渡す前（clear 前）にもう一度、引継ぎ無しで眠る
  await mgr.sleep("pm1");
  assert.equal((await savedOf())[0].sleepHandoff, undefined);
});

test("T5/T9: 引継ぎつきの眠りの wake は resume 無しで起動し、起動の前に onWake が参照つきで呼ばれる。clearSleepHandoff は id が一致する時だけ参照を外す", async () => {
  const { mgr, calls, wakes } = setupWake();
  await mgr.create({ name: "pm1" });
  await mgr.sleep("pm1", { handoff: REF });
  await mgr.wake("pm1");
  assert.equal(calls.at(-1), "start:pm1", "--continue（resume）を付けない");
  assert.deepEqual(wakes.map((w) => [w.name, w.ref]), [["pm1", REF]]);
  assert.equal(wakes[0].callsBefore.filter((c) => c === "start:pm1").length, 1, "onWake の時点で起動はまだ 1 回（create のもの）= 起動の前");
  assert.equal(wakes[0].callsBefore.at(-1), "stop:pm1");
  assert.deepEqual((await savedOf())[0].sleepHandoff, REF, "渡し終えるまで参照は残る");
  await mgr.clearSleepHandoff("pm1", "別の id");
  assert.deepEqual((await savedOf())[0].sleepHandoff, REF);
  await mgr.clearSleepHandoff("pm1", REF.id);
  assert.equal((await savedOf())[0].sleepHandoff, undefined);
});

test("T7: 引継ぎつきの wake で起動が失敗したら眠ったままに戻る（sleepHandoff が残る）。onWakeAbort が呼ばれ、次の wake でまた起動できる", async () => {
  const { mgr, sup, aborts, wakes, calls } = setupWake();
  await mgr.create({ name: "pm1" });
  await mgr.sleep("pm1", { handoff: REF });
  let fail = true;
  const realStart = sup.start;
  (sup as unknown as { start: unknown }).start = async (n: string, o?: { resume?: boolean }) => {
    if (fail) throw new Error("start 失敗");
    return realStart.call(sup, n, o);
  };
  await assert.rejects(mgr.wake("pm1"), /start 失敗/);
  assert.deepEqual(aborts, ["pm1"]);
  const rec = (await savedOf())[0];
  assert.equal(rec.sleeping, true);
  assert.deepEqual(rec.sleepHandoff, REF);
  fail = false;
  await mgr.wake("pm1");
  assert.equal(wakes.length, 2, "次の起こしでもう一度印を付ける");
  assert.equal(calls.at(-1), "start:pm1");
  // 引継ぎの無い眠りの wake の失敗では onWakeAbort は呼ばない
  assert.deepEqual(aborts, ["pm1"]);
});

test("T8: center の再起動（新しい manager + restore）: 眠ったままで起こされず、sleepHandoff が残り、その後の wake で渡る（resume 無し）", async () => {
  const first = setupWake();
  await first.mgr.create({ name: "pm1" });
  await first.mgr.sleep("pm1", { handoff: REF });
  // 同じ状態 file から新しい manager（center の再起動）
  const second = setupWake();
  await second.mgr.restore();
  assert.deepEqual(second.calls, ["add:pm1"], "起こさない（start も --continue も無い）");
  assert.equal(second.mgr.list().find((s) => s.name === "pm1")?.sleeping, true);
  assert.deepEqual(second.changes, ["pm1:true"]);
  assert.deepEqual((await savedOf())[0].sleepHandoff, REF);
  await second.mgr.wake("pm1");
  assert.equal(second.calls.at(-1), "start:pm1");
  assert.deepEqual(second.wakes.map((w) => w.ref), [REF]);
});

test("T10: 眠っている session 宛の message（sleep-gate）で起きる時も、新しい会話（resume 無し）で起動し、起動の前に onWake が呼ばれる", async () => {
  const { mgr, calls, wakes } = setupWake();
  await mgr.create({ name: "pm1" });
  await mgr.sleep("pm1", { handoff: REF });
  const made: ReturnType<typeof fakeClient>[] = [];
  const gate = createSleepGate({
    clientFactory: () => {
      const fc = fakeClient();
      made.push(fc);
      return fc.client;
    },
    wake: (n) => mgr.wake(n),
    deliver: async () => ({ ok: true }),
    peerName: (n) => `${n}-cap`,
    log: () => {},
    deliverIntervalMs: 5,
  });
  gate.sync("pm1", true);
  await tick();
  made[0].emit({ from_name: "worker-x", text: "進捗です", mode: "push" });
  await tick(50);
  assert.equal(calls.at(-1), "start:pm1");
  assert.deepEqual(wakes.map((w) => w.ref), [REF]);
  assert.equal(wakes[0].callsBefore.includes("start:pm1"), true, "最初の start は create のもの。起こす start は onWake の後");
  assert.equal(calls.filter((c) => c === "start:pm1").length, 2);
  await gate.close();
});
