/**
 * app 再起動後の状況確認の配線（docs/design/app-restart-check.md の T7・T8・T10・T12）。daemon.ts と同じ組み立て
 * （偽の supervisor・本物の SessionManager / EventHub / Resessioner / RestartChecker）で、印の付き外しと呼び順を確かめる。
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { parseConfig, type Config, type ProjectConfig } from "../src/config.js";
import { createEventHub } from "../src/events.js";
import type { RcStatus, RemoteControlSupervisor } from "../src/remote-control.js";
import { createResessioner } from "../src/resession.js";
import { cancelOnSessionEvents, createRestartChecker, RESTART_CHECK_TEXT } from "../src/restart-check.js";
import { createSessionManager, type SavedSession, type SessionInfo } from "../src/sessions.js";
import { createJsonListStore } from "../src/store.js";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const PASTE = `\u001b[200~${RESTART_CHECK_TEXT}\u001b[201~`;
const start = (source = "startup") => ({ hook_event_name: "SessionStart", source });

let dir: string;
let config: Config;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "center-restartcheck-"));
  config = parseConfig({ workspace: join(dir, "ws") }, join(dir, "c.json"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function fakeSupervisor(initial: ProjectConfig[]) {
  const map = new Map<string, RcStatus>();
  const mk = (p: ProjectConfig): RcStatus => ({
    project: p.name, path: p.path, state: "stopped", pid: null, sessionUrl: null, environmentUrl: null,
    restarts: 0, lastExit: null, startedAt: null, args: null, instructions: false, claude: { path: "claude", source: "PATH" },
    auth: "ok", loginUrl: null, loginError: null,
  });
  for (const p of initial) map.set(p.name, mk(p));
  return {
    add: (p: ProjectConfig) => void map.set(p.name, mk(p)),
    remove: async (n: string) => void map.delete(n),
    start: async (n: string) => {
      const s = map.get(n)!;
      s.state = "connected";
      s.pid = 4242;
      s.sessionUrl = `https://claude.ai/code/session_${n}`;
      return { ...s };
    },
    stop: async (n: string) => {
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
}

const savedMk = (name: string, sleeping?: boolean): SavedSession => ({ name, path: join(dir, name), permissionMode: "auto", createdAt: "2026-11-21T00:00:00Z", ...(sleeping ? { sleeping } : {}) });

/** daemon.ts と同じ配線。hook は restartCheck → resession の順。 */
async function daemonLike(saved: SavedSession[]) {
  await writeFile(join(dir, "sessions.json"), JSON.stringify(saved));
  const events = createEventHub();
  const inputs: string[] = [];
  const core = { push: () => undefined, input: (_n: string, d: Buffer) => (inputs.push(d.toString()), true) };
  const restartCheck = createRestartChecker({ core, resessionPending: (n) => res.pending(n), log: () => {}, submitDelayMs: 1 });
  cancelOnSessionEvents(events, restartCheck);
  const mgr = createSessionManager({
    config, supervisor: fakeSupervisor(config.projects), store: createJsonListStore<SavedSession>(join(dir, "sessions.json"), () => {}), log: () => {}, waitMs: 0, events,
    activity: () => "idle",
    onRestoreStart: (n) => restartCheck.arm(n),
    onRestoreFail: (n) => restartCheck.cancel(n),
  });
  const res = createResessioner({
    info: (n) => mgr.list().find((x) => x.name === n),
    restartFresh: (n) => mgr.restartFresh(n),
    saveToMemory: async () => "none",
    readFromMemory: async () => "none",
    core,
    dir: join(dir, "handoffs"),
    log: () => {},
    submitDelayMs: 1,
    cancelRestartCheck: (n) => restartCheck.cancel(n),
  });
  const hook = (n: string, p: unknown): void => {
    restartCheck.onHook(n, p);
    res.onHook(n, p);
  };
  return { mgr, res, restartCheck, events, inputs, hook };
}

test("T12: restore で復帰した session の最初の SessionStart でだけ送る。自動の再起動の後の SessionStart では送らない", async () => {
  const d = await daemonLike([savedMk("a")]);
  await d.mgr.restore();
  assert.equal(d.restartCheck.pending("a"), true);
  d.hook("a", start());
  await sleep(30);
  assert.deepEqual(d.inputs, [PASTE, "\r"]);
  d.hook("a", start()); // claude が落ちて自動で再起動した後
  d.hook("a", start("resume"));
  await sleep(30);
  assert.equal(d.inputs.length, 2);
});

test("T12: スリープで復帰した session は wake して SessionStart が来ても送らない。新規の session も送らない", async () => {
  const d = await daemonLike([savedMk("z", true)]);
  await d.mgr.restore();
  assert.equal(d.restartCheck.pending("z"), false);
  await d.mgr.wake("z");
  d.hook("z", start());
  await d.mgr.create({ name: "fresh" });
  d.hook("fresh", start());
  await sleep(30);
  assert.deepEqual(d.inputs, []);
});

test("T10: 印を付けた後に眠らせる・削除する・restartFresh すると印が外れ、後の startup で送らない。context など他の通知では外れない", async () => {
  const d = await daemonLike([savedMk("a"), savedMk("b"), savedMk("c"), savedMk("e")]);
  await d.mgr.restore();
  d.events.publish({ reason: "context", name: "e" });
  d.events.publish({ reason: "activity", name: "e" });
  assert.equal(d.restartCheck.pending("e"), true);
  await d.mgr.sleep("a");
  await d.mgr.delete("b");
  await d.mgr.restartFresh("c");
  for (const n of ["a", "b", "c"]) assert.equal(d.restartCheck.pending(n), false, n);
  for (const n of ["a", "b", "c"]) d.hook(n, start());
  await sleep(30);
  assert.deepEqual(d.inputs, []);
  d.hook("e", start()); // 触っていない session は送る
  await sleep(30);
  assert.deepEqual(d.inputs, [PASTE, "\r"]);
});

test("T10: sleep・deleted・restarted の各通知が個別に印を外す", () => {
  for (const reason of ["sleep", "deleted", "restarted"]) {
    const events = createEventHub();
    const checker = createRestartChecker({ core: { input: () => true }, resessionPending: () => false, log: () => {} });
    cancelOnSessionEvents(events, checker);
    checker.arm("s");
    checker.arm("t");
    events.publish({ reason: reason as never, name: "s" });
    assert.equal(checker.pending("s"), false, reason);
    assert.equal(checker.pending("t"), true, reason);
  }
});

const info = { name: "pm1", state: "connected", sleeping: false, source: "session", activity: "idle", remote: { running: 0, waitingReply: 0 } } as unknown as SessionInfo;

function pair() {
  const inputs: string[] = [];
  const core = { push: () => undefined, input: (_n: string, d: Buffer) => (inputs.push(d.toString()), true) };
  let restarts = 0;
  const checker = createRestartChecker({ core, resessionPending: (n) => res.pending(n), log: () => {}, submitDelayMs: 1 });
  const res = createResessioner({
    info: () => info,
    restartFresh: async () => void restarts++,
    saveToMemory: async () => "memory",
    readFromMemory: async () => ({ body: "引継ぎの本文" }),
    core,
    dir: join(dir, "handoffs"),
    log: () => {},
    submitDelayMs: 1,
    defer: (fn) => fn(),
    cancelRestartCheck: (n) => checker.cancel(n),
  });
  return { checker, res, inputs, restarts: () => restarts };
}

test("T7: リセッションの run が restartFresh を呼ぶ前に確認の印を取り消し、再起動後の最初の入力は引継ぎだけ（合計 1 回）", async () => {
  const p = pair();
  p.checker.arm("pm1");
  await p.res.request("pm1", "引継ぎ");
  p.res.onHook("pm1", { hook_event_name: "Stop" });
  for (let i = 0; i < 200 && p.restarts() === 0; i++) await sleep(5);
  assert.equal(p.restarts(), 1);
  assert.equal(p.checker.pending("pm1"), false, "restartFresh の後に印が残らない");
  p.checker.onHook("pm1", start());
  p.res.onHook("pm1", start());
  await sleep(50);
  assert.equal(p.inputs.length, 2);
  assert.ok(p.inputs[0]!.includes("引継ぎの本文") && !p.inputs[0]!.includes(RESTART_CHECK_TEXT));
});

test("T8: 同じ SessionStart を restartCheck → resession の順に渡すと、両方の印があっても入力は 1 回（引継ぎだけ）。逆順だと 2 回になる", async () => {
  const run = async (order: "check-first" | "res-first") => {
    const p = pair();
    await p.res.request("pm1", "引継ぎ");
    p.res.onHook("pm1", { hook_event_name: "Stop" });
    for (let i = 0; i < 200 && p.restarts() === 0; i++) await sleep(5);
    p.checker.arm("pm1"); // 取り消しの後に付いた印（防衛の確認）
    const hooks = [() => p.checker.onHook("pm1", start()), () => p.res.onHook("pm1", start())];
    for (const h of order === "check-first" ? hooks : hooks.reverse()) h();
    await sleep(60);
    return p.inputs;
  };
  const ok = await run("check-first");
  assert.equal(ok.length, 2);
  assert.ok(ok[0]!.includes("引継ぎの本文"));
  const bad = await run("res-first");
  assert.equal(bad.length, 4, "順を逆にすると確認も送られる（daemon.ts は check-first を守る）");
});

test("T8: daemon.ts は restartCheck.onHook を resession.onHook より先に呼び、restore の印・取り消し・リセッションの取り消しを配線している", async () => {
  const src = await readFile(join(import.meta.dirname, "../src/daemon.ts"), "utf8");
  const a = src.indexOf("restartCheck.onHook(name, payload)");
  const b = src.indexOf("resession.onHook(name, payload)");
  assert.ok(a > 0 && b > 0 && a < b, "restartCheck.onHook が resession.onHook より先");
  assert.ok(src.includes("onRestoreStart: (name) => restartCheck.arm(name)"));
  assert.ok(src.includes("onRestoreFail: (name) => restartCheck.cancel(name)"));
  assert.ok(src.includes("cancelRestartCheck: (name) => restartCheck.cancel(name)"));
  assert.ok(src.includes("cancelOnSessionEvents(events, restartCheck)"));
});
