import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { existsSync, readFileSync, renameSync } from "node:fs";
import { parseConnections } from "../src/mcp-connections.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { parseConfig, type Config, type ProjectConfig } from "../src/config.js";
import type { RcStatus, RemoteControlSupervisor } from "../src/remote-control.js";
import { createSessionManager, type SavedSession } from "../src/sessions.js";
import { createMemoryFile } from "../src/memory-settings.js";
import { createJsonListStore, createJsonObjectStore } from "../src/store.js";
import type { ProjectSettings } from "../src/project-settings.js";
import { createEventHub, type SessionsEvent } from "../src/events.js";

/** supervisor の偽物。add / remove / start / list / status だけ持つ。 */
function fakeSupervisor(initial: ProjectConfig[]) {
  const map = new Map<string, RcStatus>();
  const calls: string[] = [];
  /** start が投げる名前。 */
  const failStart = new Set<string>();
  const opts: { add: Record<string, unknown>; start: Record<string, unknown>; setInstr: Record<string, string>; setDirs: Record<string, string[]>; setStyle: Record<string, string>; setMem: Record<string, unknown>; setCoord: (string | null)[] } = { add: {}, start: {}, setInstr: {}, setDirs: {}, setStyle: {}, setMem: {} };
  const mk = (p: ProjectConfig): RcStatus => ({
    project: p.name, path: p.path, state: "stopped", pid: null, sessionUrl: null, environmentUrl: null,
    restarts: 0, lastExit: null, startedAt: null, args: null, instructions: false, claude: { path: "claude", source: "PATH" },
    auth: "ok", loginUrl: null, loginError: null,
  });
  for (const p of initial) map.set(p.name, mk(p));
  const sup = {
    add: (p: ProjectConfig, o?: { wrapper?: boolean; instructions?: string; addDirs?: string[] }) => {
      opts.add[p.name] = o;
      if (map.has(p.name)) throw new Error("既に存在");
      calls.push(`add:${p.name}:${p.permissionMode}${o?.wrapper ? ":wrapper" : ""}`);
      map.set(p.name, mk(p));
    },
    remove: async (n: string) => {
      calls.push(`remove:${n}`);
      map.delete(n);
    },
    start: async (n: string, o?: { resume?: boolean; instructions?: string }) => {
      opts.start[n] = o;
      if (failStart.has(n)) throw new Error(`start 失敗: ${n}`);
      calls.push(`start:${n}${o?.resume ? ":resume" : ""}`);
      const s = map.get(n)!;
      s.state = "connected";
      s.sessionUrl = `https://claude.ai/code/session_${n}`;
      return { ...s };
    },
    setInstructions: (n: string, v: string) => {
      opts.setInstr[n] = v;
    },
    setAddDirs: (n: string, v: string[]) => {
      opts.setDirs[n] = v;
    },
    setOutputStyle: (n: string, v: string) => {
      opts.setStyle[n] = v;
    },
    setMemory: (n: string, v: unknown) => {
      opts.setMem[n] = v;
    },
    status: (n: string) => ({ ...map.get(n)! }),
    list: () => [...map.values()].map((s) => ({ ...s })),
  } as unknown as RemoteControlSupervisor;
  return { sup, calls, opts, failStart, map };
}

let dir: string;
let config: Config;
const project = (name: string, path: string): ProjectConfig => ({ name, path, spawn: "same-dir", permissionMode: "auto", autostart: true });
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "center-sess-"));
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
  const centerStore = createJsonObjectStore<ProjectSettings>(join(dir, "center-settings.json"), () => {});
  const mgr = createSessionManager({ config, supervisor: fs.sup, store, centerStore, log: () => {}, waitMs: 0, events, ...extra });
  return { ...fs, store, centerStore, mgr, seen };
};

test("create: path 省略は <workspace>/<name> を作り、起動して保存する。config の projects には書かない", async () => {
  const { mgr, calls } = setup();
  const r = await mgr.create({ name: "pm1" });
  assert.equal(r.path, join(dir, "ws", "pm1"));
  assert.ok((await stat(r.path)).isDirectory());
  assert.equal(r.state, "connected");
  assert.equal(r.source, "session");
  assert.deepEqual(calls, ["add:pm1:auto:wrapper", "start:pm1"]);
  const saved = JSON.parse(await readFile(join(dir, "sessions.json"), "utf8")) as SavedSession[];
  assert.equal(saved.length, 1);
  assert.deepEqual({ name: saved[0].name, path: saved[0].path, permissionMode: saved[0].permissionMode }, { name: "pm1", path: r.path, permissionMode: "auto" });
  assert.equal(config.projects.length, 1);
  assert.deepEqual(config.projects.map((p) => p.name), ["cfg"]);
});

test("create: 1 回の作成で add / start は 1 回だけ。起動前に created event で一覧へ載り、その間の同名 create は重複で拒否される（クライアントは再送しない）", async () => {
  const events = createEventHub();
  const { mgr, calls } = setup({ events });
  const listed: string[][] = [];
  events.subscribe((e) => {
    if (e.reason === "created") listed.push(mgr.list().map((x) => x.name));
  });
  const first = mgr.create({ name: "pm1" });
  const second = mgr.create({ name: "pm1" });
  const [ok, dup] = await Promise.allSettled([first, second]);
  assert.equal(ok.status, "fulfilled");
  assert.equal(dup.status, "rejected");
  assert.match(String((dup as PromiseRejectedResult).reason), /name が既に使われている: pm1/);
  assert.deepEqual(calls, ["add:pm1:auto:wrapper", "start:pm1"]);
  assert.deepEqual(listed, [["cfg", "pm1"]]);
});

test("create: path と permissionMode を指定できる。相対 path は拒否", async () => {
  const { mgr, calls } = setup();
  const r = await mgr.create({ name: "a", path: join(dir, "elsewhere"), permissionMode: "plan" });
  assert.equal(r.path, join(dir, "elsewhere"));
  assert.ok(calls.includes("add:a:plan:wrapper"));
  await assert.rejects(mgr.create({ name: "b", path: "rel/x" }), /絶対パス/);
});

test("create: name の重複・既存 project 名（cfg）との衝突・path の重複・不正 name を拒否", async () => {
  const { mgr } = setup();
  await mgr.create({ name: "pm1" });
  await assert.rejects(mgr.create({ name: "pm1", path: join(dir, "o") }), /name が既に使われている/);
  await assert.rejects(mgr.create({ name: "cfg", path: join(dir, "o2") }), /name が既に使われている/);
  await assert.rejects(mgr.create({ name: "pm2", path: join(dir, "ws", "pm1") }), /path が既に使われている/);
  await assert.rejects(mgr.create({ name: "pm3", path: join(dir, "cfgproj") }), /path が既に使われている.*cfg/);
  await assert.rejects(mgr.create({ name: "a b" }), /英数字/);
});

test("create: config に workspace が無く path も無ければ拒否", async () => {
  config = parseConfig({}, join(dir, "c.json"));
  const { mgr } = setup();
  await assert.rejects(mgr.create({ name: "x" }), /workspace/);
});

test("create: 同時の同名 create は片方だけ成功する", async () => {
  const { mgr } = setup();
  const rs = await Promise.allSettled([mgr.create({ name: "same" }), mgr.create({ name: "same", path: join(dir, "p2") })]);
  assert.deepEqual(rs.map((r) => r.status).sort(), ["fulfilled", "rejected"]);
});

test("delete: session だけ消せる。config 由来・未定義は拒否。保存からも外れ path は残る", async () => {
  const { mgr, calls } = setup();
  const r = await mgr.create({ name: "pm1" });
  await assert.rejects(mgr.delete("cfg"), /config 由来/);
  await assert.rejects(mgr.delete("nope"), /未定義/);
  assert.deepEqual(await mgr.delete("pm1"), { name: "pm1", deleted: true });
  assert.ok(calls.includes("remove:pm1"));
  assert.deepEqual(JSON.parse(await readFile(join(dir, "sessions.json"), "utf8")), []);
  assert.ok((await stat(r.path)).isDirectory());
  assert.deepEqual(mgr.list().map((s) => s.name), ["cfg"]);
});

test("list: config と session を source で区別して返す", async () => {
  const { mgr } = setup();
  await mgr.create({ name: "pm1" });
  assert.deepEqual(mgr.list().map((s) => [s.name, s.source]), [["cfg", "config"], ["pm1", "session"]]);
});

test("restore: 保存済みを add して resume 付きで start。壊れた項目は飛ばす", async () => {
  const { mgr, calls, store } = setup();
  await store.save([
    { name: "pm1", path: join(dir, "ws", "pm1"), permissionMode: "auto", createdAt: "t" },
    { name: "bad name", path: join(dir, "x"), permissionMode: "auto", createdAt: "t" },
    { name: "pm2", path: "relative", permissionMode: "auto", createdAt: "t" },
    { name: "pm3", path: join(dir, "ws", "pm3"), permissionMode: "plan", createdAt: "t" },
  ]);
  await mgr.restore();
  assert.deepEqual(calls, ["add:pm1:auto:wrapper", "start:pm1:resume", "add:pm3:plan:wrapper", "start:pm3:resume"]);
  assert.deepEqual(mgr.list().map((s) => s.name), ["cfg", "pm1", "pm3"]);
  // 復帰した session は delete できる
  await mgr.delete("pm1");
});

test("store: 壊れた JSON・配列でない・無いファイルは空として読む", async () => {
  const { writeFile } = await import("node:fs/promises");
  const logs: string[] = [];
  const s = createJsonListStore<unknown>(join(dir, "s.json"), (m) => logs.push(m));
  assert.deepEqual(await s.load(), []);
  await writeFile(join(dir, "s.json"), "{bad");
  assert.deepEqual(await s.load(), []);
  await writeFile(join(dir, "s.json"), "{}");
  assert.deepEqual(await s.load(), []);
  assert.equal(logs.length, 2);
});

test("create: 起動直後に一度終了した（trust 未承認など）なら待たずに lastError 付きで返す", async () => {
  const { sup } = fakeSupervisor(config.projects);
  const real = sup.start;
  sup.start = async (n, o) => {
    await real(n, o);
    return { ...sup.status(n), state: "starting", sessionUrl: null, lastExit: { code: 1, signal: null, at: "t" }, lastError: "接続前に終了: Error: Workspace not trusted" };
  };
  const orig = sup.status;
  sup.status = (n) => ({ ...orig(n), state: "starting", sessionUrl: null, lastExit: { code: 1, signal: null, at: "t" }, lastError: "接続前に終了: Error: Workspace not trusted" });
  const store = createJsonListStore<SavedSession>(join(dir, "sessions.json"), () => {});
  const mgr = createSessionManager({ config, supervisor: sup, store, log: () => {}, waitMs: 5000 });
  const t0 = Date.now();
  const r = await mgr.create({ name: "pm1" });
  assert.ok(Date.now() - t0 < 2000);
  assert.match(r.lastError ?? "", /Workspace not trusted/);
});

test("events: create / delete / restore で通知する。失敗した create や拒否された delete は通知しない", async () => {
  const { mgr, store, seen } = setup();
  await mgr.create({ name: "pm1" });
  await assert.rejects(mgr.create({ name: "pm1", path: join(dir, "o") }));
  await assert.rejects(mgr.delete("cfg"));
  await mgr.delete("pm1");
  assert.deepEqual(seen, [{ reason: "created", name: "pm1" }, { reason: "deleted", name: "pm1" }]);
  await store.save([
    { name: "pm4", path: join(dir, "ws", "pm4"), permissionMode: "auto", createdAt: "t" },
    { name: "bad name", path: join(dir, "x"), permissionMode: "auto", createdAt: "t" },
  ]);
  await mgr.restore();
  assert.deepEqual(seen.slice(2), [{ reason: "restored", name: "pm4" }]);
});

test("list: contextUsage は取得元の値、無ければ null", async () => {
  const fs2 = fakeSupervisor(config.projects);
  const store = createJsonListStore<SavedSession>(join(dir, "sessions.json"), () => {});
  const usage = { usedTokens: 84_000, windowTokens: 1_000_000, percent: 8.4, updatedAt: "2026-11-03T10:00:00.000Z" };
  const mgr = createSessionManager({ config, supervisor: fs2.sup, store, log: () => {}, waitMs: 0, contextUsage: (n) => (n === "pm1" ? usage : null) });
  await mgr.create({ name: "pm1" });
  const byName = Object.fromEntries(mgr.list().map((s) => [s.name, s.contextUsage]));
  assert.deepEqual(byName, { cfg: null, pm1: usage });
  const plain = setup();
  assert.equal((await plain.mgr.create({ name: "x" })).contextUsage, null);
});

test("list: instructions は supervisor の status の真偽（本文は出さない）", async () => {
  const fs2 = fakeSupervisor(config.projects);
  const store = createJsonListStore<SavedSession>(join(dir, "sessions.json"), () => {});
  const mgr = createSessionManager({ config, supervisor: fs2.sup, store, log: () => {}, waitMs: 0 });
  assert.equal((await mgr.create({ name: "pm1" })).instructions, false);
  assert.ok(mgr.list().every((s) => typeof s.instructions === "boolean"));
  assert.ok(!JSON.stringify(mgr.list()).includes("追加指示"));
});

test("create: settings.instructions は add に渡り、sessions.json の settings に保存される。無し・空は保存しない", async () => {
  const { mgr, opts } = setup();
  await mgr.create({ name: "a", settings: { instructions: "日本語で答える\n二行目" } });
  await mgr.create({ name: "b", settings: { instructions: "" } });
  await mgr.create({ name: "c" });
  assert.equal((opts.add.a as { instructions?: string }).instructions, "日本語で答える\n二行目");
  assert.equal((opts.add.b as { instructions?: string }).instructions, undefined);
  assert.equal((opts.add.c as { instructions?: string }).instructions, undefined);
  const saved = JSON.parse(await readFile(join(dir, "sessions.json"), "utf8")) as SavedSession[];
  assert.deepEqual(saved.find((x) => x.name === "a")?.settings, { instructions: "日本語で答える\n二行目" });
  assert.ok(!("settings" in saved.find((x) => x.name === "b")!));
  assert.ok(!("settings" in saved.find((x) => x.name === "c")!));
});

test("create: 未知の項目も settings に保持する", async () => {
  const { mgr } = setup();
  await mgr.create({ name: "a", settings: { instructions: "x", skills: ["s1"], outputStyle: "terse" } });
  assert.deepEqual(mgr.getSettings("a").settings, { instructions: "x", skills: ["s1"], outputStyle: "terse" });
});

test("restore: 保存済みの settings.instructions を add に渡す。settings の未知項目は保持", async () => {
  const store = createJsonListStore<SavedSession>(join(dir, "sessions.json"), () => {});
  await store.save([
    { name: "r1", path: join(dir, "r1"), permissionMode: "auto", settings: { instructions: "保存された指示", future: 1 }, createdAt: "2026-01-01T00:00:00Z" },
    { name: "r2", path: join(dir, "r2"), permissionMode: "auto", createdAt: "2026-01-01T00:00:00Z" },
  ]);
  const { mgr, opts, calls } = setup();
  await mgr.restore();
  assert.ok(calls.includes("start:r1:resume"));
  assert.equal((opts.add.r1 as { instructions?: string }).instructions, "保存された指示");
  assert.equal((opts.add.r2 as { instructions?: string }).instructions, undefined);
  assert.deepEqual(mgr.getSettings("r1").settings, { instructions: "保存された指示", future: 1 });
  assert.deepEqual(mgr.getSettings("r2").settings, {});
});

test("getSettings: 未設定と config 由来は {}。未定義は例外", async () => {
  const { mgr } = setup();
  await mgr.create({ name: "pm1" });
  assert.deepEqual(mgr.getSettings("pm1"), { name: "pm1", settings: {} });
  assert.deepEqual(mgr.getSettings("cfg"), { name: "cfg", settings: {} });
  assert.throws(() => mgr.getSettings("nope"), /未定義の session/);
});

test("updateSettings: 項目ごとのマージ。省略は変えない、null と instructions 空文字は削除、未知項目は保持。保存して supervisor に反映", async () => {
  const { mgr, opts, calls } = setup();
  await mgr.create({ name: "pm1", settings: { instructions: "旧", keep: { a: 1 } } });
  const read = async () => (JSON.parse(await readFile(join(dir, "sessions.json"), "utf8")) as SavedSession[]).find((x) => x.name === "pm1")!;
  assert.deepEqual(await mgr.updateSettings("pm1", { instructions: "新" }), { name: "pm1", settings: { instructions: "新", keep: { a: 1 } } });
  assert.deepEqual((await read()).settings, { instructions: "新", keep: { a: 1 } });
  assert.deepEqual(await mgr.updateSettings("pm1", { other: 2 }), { name: "pm1", settings: { instructions: "新", keep: { a: 1 }, other: 2 } }); // 省略した instructions は変えない
  assert.deepEqual((await mgr.updateSettings("pm1", { instructions: "" })).settings, { keep: { a: 1 }, other: 2 });
  await mgr.updateSettings("pm1", { instructions: "再設定" });
  assert.deepEqual((await mgr.updateSettings("pm1", { instructions: null, keep: null })).settings, { other: 2 });
  assert.deepEqual((await mgr.updateSettings("pm1", { other: null })).settings, {});
  assert.ok(!("settings" in (await read())));
  assert.deepEqual(opts.setInstr.pm1, "");
  assert.equal(calls.filter((c) => c.startsWith("start:")).length, 1); // 更新で起動し直さない
});

test("updateSettings: supervisor.setInstructions に値を渡す（次の起動から効く）", async () => {
  const { mgr, opts } = setup();
  await mgr.create({ name: "pm1" });
  await mgr.updateSettings("pm1", { instructions: "次から" });
  assert.equal(opts.setInstr.pm1, "次から");
});

test("outputStyle: session の値があればそれ、無ければ center 共通の値。連結しない。更新は setOutputStyle で次の起動から", async () => {
  const { mgr, opts, calls } = setup();
  await mgr.restore();
  await mgr.updateCenterSettings({ outputStyle: "共通 style" });
  await mgr.create({ name: "a", settings: { outputStyle: "a の style" } });
  await mgr.create({ name: "b" });
  assert.equal((opts.add.a as { outputStyle?: string }).outputStyle, "a の style");
  assert.equal((opts.add.b as { outputStyle?: string }).outputStyle, "共通 style");
  await mgr.updateSettings("a", { outputStyle: null });
  assert.equal(opts.setStyle.a, "共通 style");
  await mgr.updateCenterSettings({ outputStyle: "" });
  assert.equal(opts.setStyle.a, "");
  assert.equal(opts.setStyle.b, "");
  assert.deepEqual(mgr.getCenterSettings(), { settings: {} });
  await mgr.updateSettings("b", { outputStyle: "b だけ" });
  assert.equal(opts.setStyle.b, "b だけ");
  assert.equal(calls.filter((c) => c.startsWith("start:")).length, 2); // 更新で起動し直さない
});

test("updateSettings: config 由来・未定義は拒否。保存に失敗したら記録も戻す", async () => {
  const { mgr } = setup();
  await assert.rejects(mgr.updateSettings("cfg", { instructions: "x" }), /config 由来/);
  await assert.rejects(mgr.updateSettings("nope", { instructions: "x" }), /未定義の session/);
});

test("center 共通の instructions: session の追加指示の前に空行を挟んで付く。共通だけ・session だけ・両方無しも正しい", async () => {
  const { mgr, opts } = setup();
  await mgr.restore();
  assert.deepEqual(mgr.getCenterSettings(), { settings: {} });
  assert.deepEqual(await mgr.updateCenterSettings({ instructions: "共通の指示" }), { settings: { instructions: "共通の指示" } });
  await mgr.create({ name: "a", settings: { instructions: "a の指示" } });
  await mgr.create({ name: "b" });
  assert.equal((opts.add.a as { instructions?: string }).instructions, "共通の指示\n\na の指示");
  assert.equal((opts.add.b as { instructions?: string }).instructions, "共通の指示");
  // session の更新は共通を保ったまま合成する
  await mgr.updateSettings("a", { instructions: "a の新指示" });
  assert.equal(opts.setInstr.a, "共通の指示\n\na の新指示");
  await mgr.updateSettings("a", { instructions: null });
  assert.equal(opts.setInstr.a, "共通の指示");
  // 共通の更新は全 session に反映する（起動し直さない）
  await mgr.updateSettings("a", { instructions: "a の指示" });
  await mgr.updateCenterSettings({ instructions: "新しい共通" });
  assert.deepEqual({ a: opts.setInstr.a, b: opts.setInstr.b }, { a: "新しい共通\n\na の指示", b: "新しい共通" });
  await mgr.updateCenterSettings({ instructions: "" });
  assert.deepEqual(mgr.getCenterSettings(), { settings: {} });
  assert.deepEqual({ a: opts.setInstr.a, b: opts.setInstr.b }, { a: "a の指示", b: "" });
  // sessions.json には共通を混ぜない
  const saved = JSON.parse(await readFile(join(dir, "sessions.json"), "utf8")) as SavedSession[];
  assert.deepEqual(saved.find((x) => x.name === "a")?.settings, { instructions: "a の指示" });
});

test("center 共通の設定は center-settings.json に保存され、restore で読んで add に渡す。未知の項目も保持", async () => {
  const first = setup();
  await first.mgr.restore();
  await first.mgr.updateCenterSettings({ instructions: "共通", future: { x: 1 } });
  assert.deepEqual(JSON.parse(await readFile(join(dir, "center-settings.json"), "utf8")), { instructions: "共通", future: { x: 1 } });
  await first.mgr.create({ name: "r1", settings: { instructions: "r1 の指示" } });
  const second = setup();
  await second.mgr.restore();
  assert.deepEqual(second.mgr.getCenterSettings(), { settings: { instructions: "共通", future: { x: 1 } } });
  assert.equal((second.opts.add.r1 as { instructions?: string }).instructions, "共通\n\nr1 の指示");
});

test("center 共通の設定: 保存先が無い時は保存せず、メモリ上だけで効く。壊れたファイルは無いとして読む", async () => {
  const fs = fakeSupervisor(config.projects);
  const store = createJsonListStore<SavedSession>(join(dir, "sessions.json"), () => {});
  const mgr = createSessionManager({ config, supervisor: fs.sup, store, log: () => {}, waitMs: 0 });
  await mgr.restore();
  await mgr.updateCenterSettings({ instructions: "共通" });
  await mgr.create({ name: "a" });
  assert.equal((fs.opts.add.a as { instructions?: string }).instructions, "共通");
  await assert.rejects(stat(join(dir, "center-settings.json")));
  const broken = createJsonObjectStore<ProjectSettings>(join(dir, "broken.json"), () => {});
  await writeFile(join(dir, "broken.json"), "[1,2]");
  assert.equal(await broken.load(), undefined);
  await writeFile(join(dir, "broken.json"), "{not json");
  assert.equal(await broken.load(), undefined);
});

test("addDirs: 共通と session の参照フォルダを合わせて add / setAddDirs に渡す（共通が先、重複は除く）。保存は別々", async () => {
  const { mgr, opts } = setup();
  await mgr.restore();
  await mgr.updateCenterSettings({ addDirs: ["/shared/docs", "/both"] });
  await mgr.create({ name: "a", settings: { addDirs: ["/a/ref", "/both"] } });
  await mgr.create({ name: "b" });
  assert.deepEqual((opts.add.a as { addDirs?: string[] }).addDirs, ["/shared/docs", "/both", "/a/ref"]);
  assert.deepEqual((opts.add.b as { addDirs?: string[] }).addDirs, ["/shared/docs", "/both"]);
  assert.deepEqual(mgr.getSettings("a").settings, { addDirs: ["/a/ref", "/both"] });
  await mgr.updateSettings("a", { addDirs: ["/a/new"] });
  assert.deepEqual(opts.setDirs.a, ["/shared/docs", "/both", "/a/new"]);
  await mgr.updateCenterSettings({ addDirs: null });
  assert.deepEqual({ a: opts.setDirs.a, b: opts.setDirs.b }, { a: ["/a/new"], b: [] });
  assert.deepEqual(mgr.getCenterSettings(), { settings: {} });
  await mgr.updateSettings("a", { addDirs: [] });
  assert.deepEqual(opts.setDirs.a, []);
  assert.deepEqual(mgr.getSettings("a").settings, {});
  const saved = JSON.parse(await readFile(join(dir, "sessions.json"), "utf8")) as SavedSession[];
  assert.ok(!("settings" in saved.find((x) => x.name === "a")!));
});

// -- update --

const savedOf = async (): Promise<SavedSession[]> => JSON.parse(await readFile(join(dir, "sessions.json"), "utf8")) as SavedSession[];

test("update: 名前だけ変更。止めて新しい名前で resume 起動し、保存・list・event・remotes の付け替えに反映。path は同じ", async () => {
  const renamed: [string, string][] = [];
  const { mgr, calls, seen } = setup({ renameRemoteSession: (o, n) => void renamed.push([o, n]) });
  const created = await mgr.create({ name: "pm1" });
  seen.length = 0;
  calls.length = 0;
  const r = await mgr.update({ name: "pm1", newName: "pm2" });
  assert.deepEqual(calls, ["remove:pm1", "add:pm2:auto:wrapper", "start:pm2:resume"]);
  assert.equal(r.name, "pm2");
  assert.equal(r.path, created.path);
  assert.equal(r.source, "session");
  assert.deepEqual(mgr.list().map((s) => s.name), ["cfg", "pm2"]);
  assert.deepEqual((await savedOf()).map((s) => [s.name, s.path]), [["pm2", created.path]]);
  assert.deepEqual(renamed, [["pm1", "pm2"]]);
  assert.deepEqual(seen, [{ reason: "updated", name: "pm2" }]);
});

test("update: path だけ変更（move なし）。新しい path を作り、今のフォルダは残す。resume 起動", async () => {
  const { mgr, calls, opts } = setup();
  const created = await mgr.create({ name: "pm1" });
  await writeFile(join(created.path, "keep.txt"), "x");
  calls.length = 0;
  const np = join(dir, "elsewhere", "new");
  const r = await mgr.update({ name: "pm1", path: np });
  assert.equal(r.name, "pm1");
  assert.equal(r.path, np);
  assert.ok((await stat(np)).isDirectory());
  assert.equal((await readFile(join(created.path, "keep.txt"), "utf8")), "x");
  assert.deepEqual(calls, ["remove:pm1", "add:pm1:auto:wrapper", "start:pm1:resume"]);
  assert.deepEqual((opts.start.pm1 as { resume?: boolean }).resume, true);
  assert.equal((await savedOf())[0].path, np);
});

test("update: path + move: true は今のフォルダを新しい path へ rename で移動する（中身ごと）", async () => {
  const { mgr } = setup();
  const created = await mgr.create({ name: "pm1" });
  await writeFile(join(created.path, "keep.txt"), "x");
  const np = join(dir, "moved", "deep", "pm1");
  const r = await mgr.update({ name: "pm1", path: np, move: true });
  assert.equal(r.path, np);
  assert.equal(await readFile(join(np, "keep.txt"), "utf8"), "x");
  await assert.rejects(stat(created.path));
  assert.equal((await savedOf())[0].path, np);
});

test("update: move は path 指定が無ければ無視（名前だけ変わり、フォルダはそのまま）", async () => {
  const { mgr } = setup();
  const created = await mgr.create({ name: "pm1" });
  const r = await mgr.update({ name: "pm1", newName: "pm9", move: true });
  assert.equal(r.path, created.path);
  assert.ok((await stat(created.path)).isDirectory());
});

test("update: 名前と path を同時に変更。settings（instructions / addDirs）は新しい名前へ引き継ぐ。並び順は変わらない", async () => {
  const { mgr, opts } = setup();
  await mgr.create({ name: "a" });
  await mgr.create({ name: "pm1", settings: { instructions: "日本語で", addDirs: ["/ref/x"] } });
  await mgr.create({ name: "z" });
  const np = join(dir, "both");
  const r = await mgr.update({ name: "pm1", newName: "pm2", path: np, move: true });
  assert.equal(r.name, "pm2");
  assert.deepEqual(opts.add.pm2, { wrapper: true, instructions: "日本語で", addDirs: ["/ref/x"] });
  assert.deepEqual(mgr.getSettings("pm2").settings, { instructions: "日本語で", addDirs: ["/ref/x"] });
  assert.deepEqual((await savedOf()).map((s) => s.name), ["a", "pm2", "z"]);
});

test("update: config 由来・未定義・重複・不正・変更なしを拒否し、何も止めない", async () => {
  const { mgr, calls } = setup();
  await mgr.create({ name: "pm1" });
  await mgr.create({ name: "pm2" });
  calls.length = 0;
  await assert.rejects(mgr.update({ name: "cfg", newName: "x" }), /session_create で作ったものではない（config 由来）: cfg/);
  await assert.rejects(mgr.update({ name: "nope", newName: "x" }), /未定義の session: nope/);
  await assert.rejects(mgr.update({ name: "pm1", newName: "pm2" }), /name が既に使われている: pm2/);
  await assert.rejects(mgr.update({ name: "pm1", newName: "cfg" }), /name が既に使われている: cfg/);
  await assert.rejects(mgr.update({ name: "pm1", newName: "a b" }), /英数字/);
  await assert.rejects(mgr.update({ name: "pm1", path: "rel/x" }), /絶対パス/);
  await assert.rejects(mgr.update({ name: "pm1", path: join(dir, "ws", "pm2") }), /path が既に使われている.*pm2/);
  await assert.rejects(mgr.update({ name: "pm1", path: join(dir, "cfgproj") }), /path が既に使われている.*cfg/);
  await assert.rejects(mgr.update({ name: "pm1" }), /変更が無い/);
  await assert.rejects(mgr.update({ name: "pm1", newName: "pm1", path: join(dir, "ws", "pm1") }), /変更が無い/);
  assert.deepEqual(calls, []);
  assert.deepEqual((await savedOf()).map((s) => s.name), ["pm1", "pm2"]);
});

test("update: move の rename が失敗（移動先が空でないなど）したら記録・名前・remotes を元に戻し、元の名前で起動し直す", async () => {
  const renamed: [string, string][] = [];
  const { mgr, calls } = setup({ renameRemoteSession: (o, n) => void renamed.push([o, n]) });
  const created = await mgr.create({ name: "pm1" });
  const target = join(dir, "busy");
  await mkdir(target, { recursive: true });
  await writeFile(join(target, "x"), "x"); // 空でない dir への rename は失敗する
  calls.length = 0;
  await assert.rejects(mgr.update({ name: "pm1", newName: "pm2", path: target, move: true }), /元に戻した/);
  assert.deepEqual(calls, ["remove:pm1", "add:pm1:auto:wrapper", "start:pm1:resume"]);
  assert.deepEqual(renamed, []);
  assert.deepEqual((await savedOf()).map((s) => [s.name, s.path]), [["pm1", created.path]]);
  assert.ok((await stat(created.path)).isDirectory());
  assert.deepEqual(mgr.list().map((s) => s.name), ["cfg", "pm1"]);
});

test("update: 起動(start)が失敗したら、フォルダの移動・remotes の付け替え・記録を戻して元の名前で起動し直す", async () => {
  const renamed: [string, string][] = [];
  const { mgr, calls, failStart } = setup({ renameRemoteSession: (o, n) => void renamed.push([o, n]) });
  const created = await mgr.create({ name: "pm1" });
  await writeFile(join(created.path, "keep.txt"), "x");
  failStart.add("pm2");
  calls.length = 0;
  const np = join(dir, "moved");
  await assert.rejects(mgr.update({ name: "pm1", newName: "pm2", path: np, move: true }), /元に戻した.*start 失敗: pm2/);
  assert.deepEqual(calls, ["remove:pm1", "add:pm2:auto:wrapper", "remove:pm2", "add:pm1:auto:wrapper", "start:pm1:resume"]);
  assert.deepEqual(renamed, [["pm1", "pm2"], ["pm2", "pm1"]]);
  assert.equal(await readFile(join(created.path, "keep.txt"), "utf8"), "x");
  await assert.rejects(stat(np));
  assert.deepEqual((await savedOf()).map((s) => [s.name, s.path]), [["pm1", created.path]]);
  assert.deepEqual(mgr.list().map((s) => s.name), ["cfg", "pm1"]);
});

test("update: remotes の付け替えが失敗したら全部戻し、updated の event は出さない", async () => {
  const { mgr, seen } = setup({ renameRemoteSession: () => { throw new Error("remotes 壊れ"); } });
  await mgr.create({ name: "pm1" });
  seen.length = 0;
  await assert.rejects(mgr.update({ name: "pm1", newName: "pm2" }), /remotes 壊れ/);
  assert.deepEqual((await savedOf()).map((s) => s.name), ["pm1"]);
  assert.deepEqual(seen, []);
  assert.deepEqual(mgr.list().map((s) => s.name), ["cfg", "pm1"]);
});

test("update: 復元(restore)は更新後の名前・path で行われる", async () => {
  const a = setup();
  await a.mgr.create({ name: "pm1" });
  const np = join(dir, "np");
  await a.mgr.update({ name: "pm1", newName: "pm2", path: np });
  const b = setup();
  await b.mgr.restore();
  assert.deepEqual(b.mgr.list().map((s) => [s.name, s.path]), [["cfg", join(dir, "cfgproj")], ["pm2", np]]);
});

test("create / update(newName): remote 記録と衝突する名前は理由付きで拒否し、何も止めない。衝突判定は remotes の判定に従う", async () => {
  const seen: [string, string][] = [];
  const olds: (string | undefined)[] = [];
  const conflicts = new Map<string, string>([["create:old", "cap_id を別の session が持っている"], ["rename:held", "remote 記録が残っている"]]);
  const { mgr, calls } = setup({ remoteNameConflict: (n, m, old) => { seen.push([n, m]); olds.push(old); return conflicts.get(`${m}:${n}`) ?? null; } });
  await assert.rejects(mgr.create({ name: "old" }), /cap_id を別の session が持っている/);
  assert.deepEqual(mgr.list().map((s) => s.name), ["cfg"]);
  await mgr.create({ name: "held" }); // create は rename 用の衝突では拒否されない（同名の作り直しは旧 cap を引き継ぐ）
  await mgr.create({ name: "pm1" });
  calls.length = 0;
  await assert.rejects(mgr.update({ name: "pm1", newName: "held" }), /name が既に使われている/); // 既存 session 名が先
  await mgr.delete("held");
  calls.length = 0;
  await assert.rejects(mgr.update({ name: "pm1", newName: "held" }), /remote 記録が残っている/);
  assert.deepEqual(calls, []);
  assert.deepEqual((await savedOf()).map((s) => s.name), ["pm1"]);
  await mgr.update({ name: "pm1", path: join(dir, "p-only") }); // path だけの変更では名前の衝突は見ない
  assert.ok(seen.some(([n, m]) => n === "held" && m === "rename"));
  assert.ok(!seen.some(([n, m]) => n === "pm1" && m === "rename"));
  assert.deepEqual(olds.slice(-1), ["pm1"]); // rename の判定には改名元の名前を渡す（create は渡さない）
  assert.equal(olds[0], undefined);
});

test("update: remotes の付け替えが付け替えた後に例外（persist 失敗など）でも、戻す付け替えを呼んで元に戻す", async () => {
  const renamed: [string, string][] = [];
  const { mgr } = setup({ renameRemoteSession: (o, n) => { renamed.push([o, n]); if (o === "pm1") throw new Error("persist 失敗"); } });
  await mgr.create({ name: "pm1" });
  await assert.rejects(mgr.update({ name: "pm1", newName: "pm2" }), /persist 失敗/);
  assert.deepEqual(renamed, [["pm1", "pm2"], ["pm2", "pm1"]]);
  assert.deepEqual((await savedOf()).map((s) => s.name), ["pm1"]);
  assert.deepEqual(mgr.list().map((s) => s.name), ["cfg", "pm1"]);
});

test("update: move: true で今のフォルダの配下へは移動できない。検証で拒否し、何も止めず、dir も作らない（move なしの配下 path は許す）", async () => {
  const { mgr, calls } = setup();
  const created = await mgr.create({ name: "pm1" });
  calls.length = 0;
  const inside = join(created.path, "sub", "deeper");
  await assert.rejects(mgr.update({ name: "pm1", path: inside, move: true }), /配下へは移動できない/);
  await assert.rejects(mgr.update({ name: "pm1", newName: "pm2", path: join(created.path, "sub"), move: true }), /配下へは移動できない/);
  assert.deepEqual(calls, []);
  await assert.rejects(stat(join(created.path, "sub")));
  assert.deepEqual((await savedOf()).map((s) => [s.name, s.path]), [["pm1", created.path]]);
  // 名前が前置一致するだけの兄弟 dir は配下ではない
  const sibling = created.path + "-x";
  assert.equal((await mgr.update({ name: "pm1", path: sibling, move: true })).path, sibling);
  // move なしなら配下でも新しい path を作るだけなので許す
  const r = await mgr.update({ name: "pm1", path: join(sibling, "child") });
  assert.equal(r.path, join(sibling, "child"));
});

test("list: activity / activityAt は取得元の値、無ければ unknown / null。取得元には startedAt と running が渡る", async () => {
  const fs2 = fakeSupervisor([project("cfg", "/tmp/cfg")]);
  const store = createJsonListStore<SavedSession>(join(dir, "sessions.json"), () => {});
  const asked: [string, string | null, boolean][] = [];
  const mgr = createSessionManager({
    config, supervisor: fs2.sup, store, log: () => {}, waitMs: 0,
    activity: (n, startedAt, running) => (asked.push([n, startedAt, running]), n === "pm1" ? { activity: "needs-input", activityAt: "2026-11-09T00:00:00.000Z" } : { activity: "unknown", activityAt: null }),
  });
  await mgr.create({ name: "pm1" });
  const by = Object.fromEntries(mgr.list().map((s) => [s.name, [s.activity, s.activityAt]]));
  assert.deepEqual(by, { cfg: ["unknown", null], pm1: ["needs-input", "2026-11-09T00:00:00.000Z"] });
  assert.ok(asked.some(([n, , running]) => n === "pm1" && running), "connected は running");
  assert.ok(asked.some(([n, , running]) => n === "cfg" && !running), "stopped は running でない");
  const plain = setup();
  const r = await plain.mgr.create({ name: "x" });
  assert.equal(r.activity, "unknown");
  assert.equal(r.activityAt, null);
});

test("list: remote は取得元の値、無ければ { running: 0, waitingReply: 0 }", async () => {
  const fs2 = fakeSupervisor([project("cfg", "/tmp/cfg")]);
  const store = createJsonListStore<SavedSession>(join(dir, "sessions.json"), () => {});
  const mgr = createSessionManager({
    config, supervisor: fs2.sup, store, log: () => {}, waitMs: 0,
    remote: (n) => (n === "pm1" ? { running: 2, waitingReply: 1 } : { running: 0, waitingReply: 0 }),
  });
  await mgr.create({ name: "pm1" });
  const by = Object.fromEntries(mgr.list().map((s) => [s.name, s.remote]));
  assert.deepEqual(by, { cfg: { running: 0, waitingReply: 0 }, pm1: { running: 2, waitingReply: 1 } });
  const plain = setup();
  assert.deepEqual((await plain.mgr.create({ name: "x" })).remote, { running: 0, waitingReply: 0 });
});

test("list: 認証状態（auth / loginUrl / loginError）を supervisor の値のまま返す", async () => {
  const { mgr, map } = setup();
  await mgr.create({ name: "pm1" });
  const before = mgr.list().find((s) => s.name === "pm1")!;
  assert.deepEqual([before.auth, before.loginUrl, before.loginError], ["ok", null, null]);
  const st = map.get("pm1")!;
  st.auth = "login_required";
  st.loginUrl = "https://claude.com/cai/oauth/authorize?x";
  st.loginError = "Invalid code";
  const after = mgr.list().find((s) => s.name === "pm1")!;
  assert.deepEqual([after.auth, after.loginUrl, after.loginError], ["login_required", "https://claude.com/cai/oauth/authorize?x", "Invalid code"]);
});

test("servers: session の servers だけで決まる（共通設定には無い）。未設定は undefined（全部）。空配列は「使わない」で保存され、null で戻る。旧形式（servers 無し）の settings は壊れない", async () => {
  await writeFile(join(dir, "sessions.json"), JSON.stringify([{ name: "old", path: join(dir, "old"), permissionMode: "auto", settings: { instructions: "旧形式" } }]));
  const { mgr } = setup();
  await mgr.restore();
  assert.equal(mgr.serversOf("old"), undefined, "旧形式（servers なし）は全部");
  assert.deepEqual(mgr.getSettings("old").settings, { instructions: "旧形式" });
  await mgr.create({ name: "a" });
  await mgr.create({ name: "b", settings: { servers: ["lenovo", "srv-bbbbbbbbbb", "lenovo"] } });
  assert.equal(mgr.serversOf("a"), undefined);
  assert.deepEqual(mgr.serversOf("b"), ["lenovo", "srv-bbbbbbbbbb"], "重複は除く");
  await mgr.updateSettings("a", { servers: [] });
  assert.deepEqual(mgr.serversOf("a"), [], "空配列 = どの server も使わない");
  assert.deepEqual(mgr.getSettings("a").settings, { servers: [] });
  await mgr.updateSettings("a", { servers: null });
  assert.equal(mgr.serversOf("a"), undefined, "null で session の指定を消すと全部に戻る");
  assert.equal(mgr.serversOf("nope"), undefined);
  const saved = JSON.parse(await readFile(join(dir, "sessions.json"), "utf8")) as SavedSession[];
  assert.deepEqual(saved.find((x) => x.name === "b")!.settings, { servers: ["lenovo", "srv-bbbbbbbbbb"] });
});

test("center 共通の設定は servers を受け付けない: null 以外は error で保存されず、session の servers に影響しない。null は無害。保存済みの servers は読み捨てる", async () => {
  await writeFile(join(dir, "center-settings.json"), JSON.stringify({ instructions: "共通", servers: ["old-host"] }));
  const { mgr } = setup();
  await mgr.restore();
  assert.deepEqual(mgr.getCenterSettings(), { settings: { instructions: "共通" } }, "残っている servers は読み捨てる");
  await mgr.create({ name: "a" });
  await mgr.create({ name: "b", settings: { servers: ["lenovo"] } });
  assert.equal(mgr.serversOf("a"), undefined, "共通の servers は session に効かない");
  assert.deepEqual(mgr.serversOf("b"), ["lenovo"]);
  await assert.rejects(mgr.updateCenterSettings({ servers: ["mac200"] } as never), /session の設定/);
  await assert.rejects(mgr.updateCenterSettings({ instructions: "x", servers: [] } as never), /session の設定/);
  assert.deepEqual(mgr.getCenterSettings(), { settings: { instructions: "共通" } }, "error の時は他の項目も保存しない");
  assert.equal(mgr.serversOf("a"), undefined);
  assert.deepEqual(await mgr.updateCenterSettings({ servers: null } as never), { settings: { instructions: "共通" } }, "null は無害");
  assert.deepEqual(JSON.parse(await readFile(join(dir, "center-settings.json"), "utf8")), { instructions: "共通" }, "保存し直すと servers は消える");
});

const MEM_A = { type: "http", url: "https://own.example/mcp", headers: { Authorization: "Bearer OWN-SECRET" } };
const MEM_C = { type: "http", url: "http://mem.local:3000/mcp", headers: { Authorization: "Bearer COMMON-SECRET", "X-Agent-Id": "shared" } };

test("memory: 設定の更新（create / updateSettings / updateCenterSettings）は memory を普通の MCP の設定の形で保存する（旧形式は読み替える）。session の値があれば共通は使わない。null で消す。不正な形は断り何も変えない", async () => {
  const { mgr } = setup();
  await mgr.restore();
  await mgr.create({ name: "a", settings: { memory: MEM_A } as never });
  await mgr.create({ name: "b" });
  await mgr.updateCenterSettings({ memory: { url: "http://mem.local:3000/mcp", token: "COMMON-SECRET", agentId: "shared" } } as never);
  assert.deepEqual(mgr.memoryOf("a"), MEM_A);
  assert.deepEqual(mgr.memoryOf("b"), MEM_C, "旧形式は普通の MCP の設定の形に読み替えて保存");
  assert.deepEqual(mgr.getSettings("a").settings, { memory: MEM_A });
  assert.deepEqual(mgr.getCenterSettings().settings, { memory: MEM_C });
  assert.deepEqual((await readJson("sessions.json"))[0].settings.memory, MEM_A, "Bearer の値もそのまま保存");
  assert.deepEqual((await readJson("center-settings.json")).memory, MEM_C);
  // stdio の外部記憶も書ける
  const stdio = { command: "npx", args: ["-y", "memory-mcp"], env: { MEM_KEY: "K" } };
  await mgr.updateSettings("b", { memory: stdio } as never);
  assert.deepEqual(mgr.memoryOf("b"), stdio);
  await mgr.updateSettings("b", { memory: null } as never);
  assert.deepEqual(mgr.memoryOf("b"), MEM_C, "session の値を消すと共通に戻る");
  // 不正な形は断る（値は出さない）。他の項目も変えない
  for (const bad of [{ type: "http", headers: { Authorization: "Bearer BAD-SECRET" } }, { args: ["BAD-SECRET"] }, { type: "http", url: "u", headers: { A: 1 } }]) {
    await assert.rejects(mgr.updateSettings("a", { instructions: "x", memory: bad } as never), (e: Error) => /設定が不正: memory:/.test(e.message) && !e.message.includes("BAD-SECRET"));
    await assert.rejects(mgr.updateCenterSettings({ instructions: "x", memory: bad } as never), (e: Error) => /設定が不正: memory:/.test(e.message) && !e.message.includes("BAD-SECRET"));
  }
  assert.deepEqual(mgr.getSettings("a").settings, { memory: MEM_A });
  assert.deepEqual(mgr.getCenterSettings().settings, { memory: MEM_C });
  // 旧設定の項目は誰からも受けない
  for (const k of ["mcp", "mcpConnections", "mcpSecrets", "coordinator"]) {
    await assert.rejects(mgr.updateSettings("a", { [k]: null } as never), /旧設定の項目/, `update ${k}`);
    await assert.rejects(mgr.updateCenterSettings({ [k]: null } as never), /旧設定の項目/, `center ${k}`);
    await assert.rejects(mgr.create({ name: "c", settings: { [k]: null } as never }), /旧設定の項目/, `create ${k}`);
  }
  assert.equal(mgr.list().some((x) => x.name === "c"), false);
});

test("memory: 設定 file の書き換え（CLI・運用者の直接の編集）は次の memoryOf から効く（center を再起動しない）。改名で付け替わり、削除で消える", async () => {
  const { createMcpSource } = await import("../src/mcp-source.js");
  const source = createMcpSource(join(dir, "center-settings.json"), join(dir, "sessions.json"));
  const { mgr } = setup({ mcpSource: source });
  await mgr.restore();
  await mgr.create({ name: "a" });
  assert.equal(mgr.memoryOf("a"), undefined);
  // CLI 相当: sessions.json の settings.memory を書く
  const list = await readJson("sessions.json");
  list[0].settings = { memory: { type: "http", url: "http://one/mcp" } };
  await writeFile(join(dir, "sessions.json"), JSON.stringify(list));
  assert.deepEqual(mgr.memoryOf("a"), { type: "http", url: "http://one/mcp" });
  list[0].settings = { memory: { url: "http://two/mcp", token: "T" } }; // 旧形式でも読める
  await writeFile(join(dir, "sessions.json"), JSON.stringify(list));
  assert.deepEqual(mgr.memoryOf("a"), { type: "http", url: "http://two/mcp", headers: { Authorization: "Bearer T" } });
  await writeFile(join(dir, "center-settings.json"), JSON.stringify({ memory: MEM_C }));
  assert.deepEqual(mgr.memoryOf("zz"), MEM_C, "session の値が無ければ共通");
  // center の保存（他項目の更新）は file の memory を巻き戻さない（旧形式は保存の時に普通の MCP の設定の形になる）
  await mgr.updateSettings("a", { instructions: "i" });
  assert.deepEqual((await readJson("sessions.json"))[0].settings, { memory: { type: "http", url: "http://two/mcp", headers: { Authorization: "Bearer T" } }, instructions: "i" });
  await mgr.update({ name: "a", newName: "a2" });
  assert.equal((await readJson("sessions.json")).find((r: { name: string }) => r.name === "a"), undefined);
  assert.deepEqual(mgr.memoryOf("a2"), { type: "http", url: "http://two/mcp", headers: { Authorization: "Bearer T" } }, "改名で付け替わる");
  assert.deepEqual(mgr.memoryOf("a"), MEM_C, "旧い名前は共通だけ");
  await mgr.delete("a2");
  assert.deepEqual(await readJson("sessions.json"), []);
});

test("memory 移行: memory-settings.json と旧形式の settings.memory は restore で普通の設定の memory（普通の MCP の設定の形）へ移し、file は .migrated に退ける。設定にある物が勝つ。log に値は出ない。冪等", async () => {
  const logs: string[] = [];
  await writeFile(join(dir, "center-settings.json"), JSON.stringify({ instructions: "ic" }));
  await mkdir(join(dir, "pa"), { recursive: true });
  await mkdir(join(dir, "pb"), { recursive: true });
  await mkdir(join(dir, "pc"), { recursive: true });
  await writeFile(
    join(dir, "sessions.json"),
    JSON.stringify([
      { name: "a", path: join(dir, "pa"), permissionMode: "auto", settings: { instructions: "ia" }, createdAt: "2026-01-01T00:00:00Z" },
      // 旧形式の settings.memory（0.1.5x 以前）
      { name: "b", path: join(dir, "pb"), permissionMode: "auto", settings: { memory: { url: "http://old-b/mcp", token: "OLD-B-SECRET", agentId: "bb" } }, createdAt: "2026-01-01T00:00:00Z" },
      // 既に普通の設定にある物が勝つ
      { name: "c", path: join(dir, "pc"), permissionMode: "auto", settings: { memory: MEM_A }, createdAt: "2026-01-01T00:00:00Z" },
    ]),
  );
  const memoryFile = createMemoryFile(dir);
  memoryFile.write({ common: { url: "http://old-common/mcp", token: "OLD-COMMON-SECRET", agentId: "shared" }, sessions: { a: { url: "http://old-a/mcp", token: "OLD-A-SECRET" }, c: { url: "http://lose/mcp" } } });
  const { mgr } = setup({ memoryFile, log: (m: string) => void logs.push(m) });
  await mgr.restore();
  const common = { type: "http", url: "http://old-common/mcp", headers: { Authorization: "Bearer OLD-COMMON-SECRET", "X-Agent-Id": "shared" } };
  assert.deepEqual(mgr.getCenterSettings().settings, { instructions: "ic", memory: common });
  assert.deepEqual(mgr.getSettings("a").settings, { instructions: "ia", memory: { type: "http", url: "http://old-a/mcp", headers: { Authorization: "Bearer OLD-A-SECRET" } } });
  assert.deepEqual(mgr.getSettings("b").settings, { memory: { type: "http", url: "http://old-b/mcp", headers: { Authorization: "Bearer OLD-B-SECRET", "X-Agent-Id": "bb" } } });
  assert.deepEqual(mgr.getSettings("c").settings, { memory: MEM_A }, "設定にある物が勝つ");
  const s = await readJson("sessions.json");
  assert.deepEqual(s[0].settings.memory, { type: "http", url: "http://old-a/mcp", headers: { Authorization: "Bearer OLD-A-SECRET" } }, "disk にも移る");
  assert.deepEqual(s[1].settings.memory.type, "http");
  assert.deepEqual((await readJson("center-settings.json")).memory, common);
  assert.ok(!existsSync(memoryFile.path) && existsSync(`${memoryFile.path}.migrated`), "file は .migrated に退ける");
  for (const l of logs) assert.ok(!/SECRET|old-a|old-common/.test(l), l);
  assert.deepEqual(mgr.memoryOf("a"), { type: "http", url: "http://old-a/mcp", headers: { Authorization: "Bearer OLD-A-SECRET" } });
  assert.deepEqual(mgr.memoryOf("zz"), common);
  // 2 回目の起動: 何も変わらない
  const before = { s: await readFile(join(dir, "sessions.json"), "utf8"), c: await readFile(join(dir, "center-settings.json"), "utf8") };
  const { mgr: mgr2 } = setup({ memoryFile: createMemoryFile(dir), log: () => {} });
  await mgr2.restore();
  assert.equal(await readFile(join(dir, "sessions.json"), "utf8"), before.s);
  assert.equal(await readFile(join(dir, "center-settings.json"), "utf8"), before.c);
  assert.deepEqual(mgr2.memoryOf("a"), mgr.memoryOf("a"));
});

test("memory 移行: config の projects 由来の session の値は center 共通の設定の projectMemory へ移して使い続ける（共通に置き換わらない）。移す先の無い session があれば file を退けず、その値も使い続ける", async () => {
  const logs: string[] = [];
  await writeFile(join(dir, "center-settings.json"), JSON.stringify({ instructions: "ic" }));
  const memoryFile = createMemoryFile(dir);
  memoryFile.write({ common: { url: "http://old-common/mcp", token: "OLD-COMMON-SECRET" }, sessions: { cfg: { url: "http://old-cfg/mcp", token: "OLD-CFG-SECRET", agentId: "cfg_agent" }, gone: { url: "http://gone/mcp", agentId: "g1" } } });
  const { mgr } = setup({ memoryFile, log: (m: string) => void logs.push(m) });
  await mgr.restore();
  const cfgMem = { type: "http", url: "http://old-cfg/mcp", headers: { Authorization: "Bearer OLD-CFG-SECRET", "X-Agent-Id": "cfg_agent" } };
  assert.deepEqual((await readJson("center-settings.json")).projectMemory, { cfg: cfgMem }, "config の projects 由来の session の値は projectMemory へ");
  assert.deepEqual(mgr.memoryOf("cfg"), cfgMem, "共通ではなく自分の値を使う");
  assert.deepEqual(mgr.memoryOf("gone"), { type: "http", url: "http://gone/mcp", headers: { "X-Agent-Id": "g1" } }, "移す先の無い session の値も失わない");
  assert.ok(existsSync(memoryFile.path) && !existsSync(`${memoryFile.path}.migrated`), "移せない物があれば file を退けない");
  assert.ok(logs.some((l) => /移す先が無い/.test(l) && /gone/.test(l)), "名前を log に出す");
  for (const l of logs) assert.ok(!/SECRET|old-cfg/.test(l), l);
  // 設定の画面（起動元）からの共通の更新は projectMemory を書けず、読みからも消さない
  await assert.rejects(mgr.updateCenterSettings({ projectMemory: {} } as never), /projectMemory/);
  await mgr.updateCenterSettings({ instructions: "ic2" });
  assert.deepEqual((await readJson("center-settings.json")).projectMemory, { cfg: cfgMem }, "他の項目の保存で消えない");
  // 2 回目の起動: projectMemory は二重に足さず、file は残ったまま同じ値を使う
  const { mgr: mgr2 } = setup({ memoryFile: createMemoryFile(dir), log: () => {} });
  await mgr2.restore();
  assert.deepEqual((await readJson("center-settings.json")).projectMemory, { cfg: cfgMem });
  assert.deepEqual(mgr2.memoryOf("gone"), mgr.memoryOf("gone"));
});

test("memory 移行の失敗: 設定へ保存できなければ memory-settings.json を残し、この起動は file の値も使う。失敗を log に残し、値は出さない。書ける次の起動で移る", async () => {
  const logs: string[] = [];
  await mkdir(join(dir, "pa"), { recursive: true });
  await writeFile(join(dir, "sessions.json"), JSON.stringify([{ name: "a", path: join(dir, "pa"), permissionMode: "auto", settings: { instructions: "ia" }, createdAt: "2026-01-01T00:00:00Z" }]));
  const memoryFile = createMemoryFile(dir);
  memoryFile.write({ common: { url: "http://old-common/mcp", token: "OLD-COMMON-SECRET" }, sessions: { a: { url: "http://old-a/mcp", token: "OLD-A-SECRET" } } });
  const failing = <T extends { save: (...a: never[]) => Promise<void> }>(st: T): T => ({ ...st, save: async () => { throw new Error("EACCES: permission denied"); } });
  const store = failing(createJsonListStore<SavedSession>(join(dir, "sessions.json"), () => {}));
  const centerStore = failing(createJsonObjectStore<ProjectSettings>(join(dir, "center-settings.json"), () => {}));
  const { mgr } = setup({ memoryFile, store, centerStore, log: (m: string) => void logs.push(m) });
  await mgr.restore();
  assert.ok(existsSync(memoryFile.path), "file は残す");
  assert.ok(logs.some((l) => /移行失敗/.test(l)), "失敗を log に残す");
  for (const l of logs) assert.ok(!/SECRET/.test(l), l);
  assert.deepEqual(mgr.memoryOf("a"), { type: "http", url: "http://old-a/mcp", headers: { Authorization: "Bearer OLD-A-SECRET" } });
  assert.deepEqual(mgr.memoryOf("other"), { type: "http", url: "http://old-common/mcp", headers: { Authorization: "Bearer OLD-COMMON-SECRET" } }, "この起動は file の値も使う");
  // 書ける次の起動で移る
  const { mgr: mgr2 } = setup({ memoryFile: createMemoryFile(dir), log: () => {} });
  await mgr2.restore();
  assert.ok(!existsSync(memoryFile.path) && existsSync(`${memoryFile.path}.migrated`));
  assert.deepEqual((await readJson("sessions.json"))[0].settings, { instructions: "ia", memory: { type: "http", url: "http://old-a/mcp", headers: { Authorization: "Bearer OLD-A-SECRET" } } });
  assert.deepEqual((await readJson("center-settings.json")).memory, { type: "http", url: "http://old-common/mcp", headers: { Authorization: "Bearer OLD-COMMON-SECRET" } });
});

const COORD = { transport: "builtin", builtin: "coordinator" };
const rec = (name: string, settings?: unknown) => ({ name, path: join(dir, `p-${name}`), permissionMode: "auto", ...(settings ? { settings } : {}), createdAt: "2026-01-01T00:00:00Z" });
const readJson = async (f: string): Promise<any> => JSON.parse(await readFile(join(dir, f), "utf8"));

test("coordinator 移行: 旧 center-settings.json の coordinator を、その session の設定の mcpServers（bantou-coordinator）へ移し、旧設定から消す。他の項目は残す。冪等", async () => {
  await writeFile(join(dir, "center-settings.json"), JSON.stringify({ instructions: "共通", coordinator: { session: "main" } }));
  await writeFile(join(dir, "sessions.json"), JSON.stringify([rec("main", { instructions: "m" }), rec("other")]));
  const { mgr } = setup();
  await mgr.restore();
  const c = await readJson("center-settings.json");
  assert.ok(!("coordinator" in c));
  assert.equal(c.instructions, "共通");
  const s = await readJson("sessions.json");
  assert.deepEqual(s[0].settings, { instructions: "m", mcpServers: { "bantou-coordinator": COORD } });
  assert.equal(s[1].settings, undefined, "他の session には付かない");
  const { data } = mgr.mcpConnections();
  assert.deepEqual(data.sessions.main, { "bantou-coordinator": COORD });
  assert.deepEqual(data.common, {});
  // 2 回目の起動: 旧設定が無いので何も変わらない
  const before = await readFile(join(dir, "sessions.json"), "utf8");
  const { mgr: mgr2 } = setup();
  await mgr2.restore();
  assert.equal(await readFile(join(dir, "sessions.json"), "utf8"), before);
  assert.deepEqual(mgr2.mcpConnections().data.sessions.main, { "bantou-coordinator": COORD });
});

test("coordinator 移行: 運用者が外した（null）割り当ては戻さない。既にある接続の設定が勝つ", async () => {
  await writeFile(join(dir, "center-settings.json"), JSON.stringify({ coordinator: { session: "main" } }));
  await writeFile(join(dir, "sessions.json"), JSON.stringify([rec("main", { mcpServers: { "bantou-coordinator": null } })]));
  const { mgr } = setup();
  await mgr.restore();
  assert.deepEqual(mgr.mcpConnections().data.sessions.main, { "bantou-coordinator": null });
  assert.ok(!("coordinator" in (await readJson("center-settings.json"))), "旧設定は消える");
});

test("coordinator 移行: 旧設定の session が無い・壊れた旧設定。移せない時は旧設定を残して log（error）に出し、壊れた値は捨てる", async () => {
  const logs: string[] = [];
  await writeFile(join(dir, "center-settings.json"), JSON.stringify({ coordinator: { session: "gone" }, instructions: "i" }));
  await writeFile(join(dir, "sessions.json"), JSON.stringify([rec("main")]));
  const { mgr } = setup({ log: (m: string) => void logs.push(m) });
  await mgr.restore();
  assert.deepEqual((await readJson("center-settings.json")).coordinator, { session: "gone" }, "移せなかった旧設定は残る");
  assert.ok(logs.some((l) => /移行失敗/.test(l) && /gone/.test(l)), "失敗を log に出す");
  assert.deepEqual(mgr.mcpConnections().data.sessions, {}, "統括の口は割り当て無し");
  // 他項目の更新の保存でも、旧設定は disk から消えない
  await mgr.updateCenterSettings({ instructions: "i2" });
  assert.deepEqual((await readJson("center-settings.json")).coordinator, { session: "gone" });
  // 壊れた値は捨てる
  await writeFile(join(dir, "center-settings.json"), JSON.stringify({ coordinator: { session: "bad name" }, instructions: "i" }));
  const { mgr: m3 } = setup();
  await m3.restore();
  assert.deepEqual(await readJson("center-settings.json"), { instructions: "i" });
});

test("mcp-connections.json 移行: common は center 共通の設定、session ごとはその session の設定へ移し、file は .migrated に退ける。設定にある物が勝つ。冪等", async () => {
  const logs: string[] = [];
  const fileData = {
    version: 1,
    common: { shared: { transport: "http", url: "https://shared.example/mcp" }, dup: { transport: "http", url: "https://old.example/mcp" } },
    sessions: { main: { extra: { transport: "http", url: "https://extra.example/mcp" }, shared: null } },
  };
  const legacyPath = join(dir, "mcp-connections.json");
  await writeFile(legacyPath, JSON.stringify(fileData));
  await writeFile(join(dir, "center-settings.json"), JSON.stringify({ mcpServers: { dup: { transport: "http", url: "https://new.example/mcp" } } }));
  await writeFile(join(dir, "sessions.json"), JSON.stringify([rec("main"), rec("other")]));
  const legacyConnections = {
    load: () => (existsSync(legacyPath) ? { ...parseConnections(JSON.parse(readFileSync(legacyPath, "utf8"))), exists: true } : { data: parseConnections(undefined).data, exists: false }),
    retire: () => renameSync(legacyPath, `${legacyPath}.migrated`),
  };
  const { mgr } = setup({ legacyConnections, log: (m: string) => void logs.push(m) });
  await mgr.restore();
  const { data } = mgr.mcpConnections();
  assert.equal((data.common.shared as { url: string }).url, "https://shared.example/mcp");
  assert.equal((data.common.dup as { url: string }).url, "https://new.example/mcp", "設定にある物が勝つ");
  assert.deepEqual(Object.keys(data.sessions.main ?? {}).sort(), ["extra", "shared"]);
  assert.equal(data.sessions.main?.shared, null);
  assert.equal(data.sessions.other, undefined, "他の session には付かない");
  assert.ok(existsSync(`${legacyPath}.migrated`) && !existsSync(legacyPath), "file は退ける");
  assert.ok((await readJson("center-settings.json")).mcpServers.shared);
  assert.ok((await readJson("sessions.json"))[0].settings.mcpServers.extra);
  // 2 回目: file が無いので何も変わらない
  const before = await readFile(join(dir, "sessions.json"), "utf8");
  const { mgr: m2 } = setup({ legacyConnections });
  await m2.restore();
  assert.equal(await readFile(join(dir, "sessions.json"), "utf8"), before);
  for (const l of logs) assert.ok(!/shared\.example|extra\.example/.test(l), `log に url を出さない: ${l}`);
});

test("mcp-connections.json 移行の失敗: 壊れた file・session が無い・保存できない時は file を残し、log（移行失敗）に出す（握りつぶさない）。設定には何も壊れた物を入れない", async () => {
  const logs: string[] = [];
  const legacyPath = join(dir, "mcp-connections.json");
  await writeFile(legacyPath, "{ broken");
  await writeFile(join(dir, "sessions.json"), JSON.stringify([rec("main")]));
  const mk = () => ({
    load: () => ({ ...parseConnections((() => { try { return JSON.parse(readFileSync(legacyPath, "utf8")); } catch { return undefined; } })()), exists: existsSync(legacyPath), problem: "壊れている" }),
    retire: () => renameSync(legacyPath, `${legacyPath}.migrated`),
  });
  const { mgr } = setup({ legacyConnections: mk(), log: (m: string) => void logs.push(m) });
  await mgr.restore();
  assert.ok(existsSync(legacyPath));
  assert.ok(logs.some((l) => /移行失敗/.test(l)));
  // session が無い
  await writeFile(legacyPath, JSON.stringify({ version: 1, common: {}, sessions: { gone: { x: { transport: "http", url: "https://x.example/mcp" } } } }));
  const logs2: string[] = [];
  const ok = () => ({ load: () => ({ ...parseConnections(JSON.parse(readFileSync(legacyPath, "utf8"))), exists: true }), retire: () => renameSync(legacyPath, `${legacyPath}.migrated`) });
  const { mgr: m2 } = setup({ legacyConnections: ok(), log: (m: string) => void logs2.push(m) });
  await m2.restore();
  assert.ok(existsSync(legacyPath), "移せなかったので file は残る");
  assert.ok(logs2.some((l) => /移行失敗/.test(l) && /gone/.test(l)));
  // 退けられない
  await writeFile(legacyPath, JSON.stringify({ version: 1, common: { c: { transport: "http", url: "https://c.example/mcp" } }, sessions: {} }));
  const logs3: string[] = [];
  const { mgr: m3 } = setup({ legacyConnections: { ...ok(), retire: () => { throw new Error("EACCES"); } }, log: (m: string) => void logs3.push(m) });
  await m3.restore();
  assert.ok(logs3.some((l) => /移行失敗/.test(l) && /退けられない/.test(l)));
  assert.ok(m3.mcpConnections().data.common.c, "この起動では設定へ移っていて使える");
});

test("mcpServers: 設定の更新（session_create / session の設定 / center 共通の設定）で書ける（起動元の制限は tools の入口）。不正な形・旧設定の項目は断り何も変えない。他項目の更新で既存の mcpServers は消えない", async () => {
  await writeFile(join(dir, "center-settings.json"), JSON.stringify({ mcpServers: { shared: { transport: "http", url: "https://shared.example/mcp" } } }));
  await writeFile(join(dir, "sessions.json"), JSON.stringify([rec("main", { mcpServers: { "bantou-coordinator": COORD } })]));
  const { mgr } = setup();
  await mgr.restore();
  for (const bad of [{ coordinator: { session: "main" } }, { mcpConnections: {} }, { mcp: null }, { mcpSecrets: {} }]) {
    await assert.rejects(mgr.updateSettings("main", bad as never), /旧設定の項目/);
    await assert.rejects(mgr.updateCenterSettings(bad as never), /旧設定の項目/);
    await assert.rejects(mgr.create({ name: "n1", settings: bad as never } as never), /旧設定の項目/);
  }
  for (const bad of [{ mcpServers: { x: { args: ["SECRET-ARG"] } } }, { mcpServers: { bantou: { command: "x" } } }, { mcpServers: { x: "SECRET-ARG" } }]) {
    await assert.rejects(mgr.updateSettings("main", bad as never), (e: Error) => /設定が不正: mcpServers\./.test(e.message) && !e.message.includes("SECRET-ARG"));
    await assert.rejects(mgr.updateCenterSettings(bad as never), (e: Error) => /設定が不正: mcpServers\./.test(e.message) && !e.message.includes("SECRET-ARG"));
    await assert.rejects(mgr.create({ name: "n1", settings: bad as never } as never), /設定が不正/);
  }
  await assert.rejects(mgr.updateCenterSettings({ mcpServers: { shared: null } } as never), /null は session の設定でだけ/);
  assert.equal(mgr.list().some((x) => x.name === "n1"), false);
  assert.deepEqual(mgr.mcpConnections().data.sessions.main, { "bantou-coordinator": COORD });
  // 他項目の更新で mcpServers は消えない
  await mgr.updateSettings("main", { instructions: "i" });
  await mgr.updateCenterSettings({ instructions: "c" });
  assert.ok((await readJson("sessions.json"))[0].settings.mcpServers["bantou-coordinator"]);
  assert.ok((await readJson("center-settings.json")).mcpServers.shared);
  assert.deepEqual(Object.keys(mgr.mcpConnections().data.common), ["shared"]);
  // 書ける（普通の MCP の設定）
  const h = { type: "http", url: "https://h.example/mcp", headers: { Authorization: "Bearer HV" } };
  await mgr.updateSettings("main", { mcpServers: { "bantou-coordinator": COORD, h } } as never);
  await mgr.create({ name: "n2", settings: { mcpServers: { s: { command: "npx", args: ["-y", "p"] } } } as never });
  assert.deepEqual((await readJson("sessions.json"))[0].settings.mcpServers, { "bantou-coordinator": COORD, h });
  assert.deepEqual(mgr.getSettings("n2").settings, { mcpServers: { s: { command: "npx", args: ["-y", "p"] } } });
  assert.deepEqual(mgr.mcpConnections().data.sessions.n2, { s: { command: "npx", args: ["-y", "p"] } });
});

test("coordinator: center 共通の設定の更新では旧設定の coordinator・mcpConnections を受けない（統括の口は mcpServers の bantou-coordinator で割り当てる）。設定は変わらない", async () => {
  const { mgr } = setup();
  await assert.rejects(mgr.updateCenterSettings({ coordinator: { session: "main" } } as never), /旧設定の項目/);
  await assert.rejects(mgr.updateCenterSettings({ mcpConnections: {} } as never), /旧設定の項目/);
  assert.deepEqual(mgr.getCenterSettings().settings, {});
});

test("mcpSource: 設定 file の mcpServers を呼び出しの度に読む（運用者の書き換えが再起動なしで効く）。読めない時は割り当て無し。center の保存は運用者の書き換えを巻き戻さない", async () => {
  const { createMcpSource } = await import("../src/mcp-source.js");
  await writeFile(join(dir, "sessions.json"), JSON.stringify([rec("main", { instructions: "m" }), rec("other")]));
  const source = createMcpSource(join(dir, "center-settings.json"), join(dir, "sessions.json"));
  const { mgr } = setup({ mcpSource: source });
  await mgr.restore();
  assert.deepEqual(mgr.mcpConnections().data.sessions, {});
  // 運用者が session の設定に割り当てを書く
  await writeFile(join(dir, "sessions.json"), JSON.stringify([rec("main", { instructions: "m", mcpServers: { "bantou-coordinator": COORD } }), rec("other")]));
  assert.deepEqual(mgr.mcpConnections().data.sessions.main, { "bantou-coordinator": COORD });
  // center の保存（他項目の更新）が、運用者の書き換えを巻き戻さない
  await mgr.updateSettings("main", { instructions: "m2" });
  const s = await readJson("sessions.json");
  assert.deepEqual(s[0].settings, { instructions: "m2", mcpServers: { "bantou-coordinator": COORD } });
  // 共通の設定
  await writeFile(join(dir, "center-settings.json"), JSON.stringify({ mcpServers: { shared: { transport: "http", url: "https://shared.example/mcp" } } }));
  assert.deepEqual(Object.keys(mgr.mcpConnections().data.common), ["shared"]);
  await mgr.updateCenterSettings({ instructions: "c" });
  assert.ok((await readJson("center-settings.json")).mcpServers.shared, "共通の mcpServers も巻き戻さない");
  // 外す（運用者が消す）と次の判定から外れる
  await writeFile(join(dir, "sessions.json"), JSON.stringify([rec("main", { instructions: "m2" }), rec("other")]));
  assert.deepEqual(mgr.mcpConnections().data.sessions, {});
  // 壊れた file は割り当て無し（fail closed）
  await writeFile(join(dir, "sessions.json"), "{ broken");
  assert.deepEqual(mgr.mcpConnections().data, { version: 1, common: {}, sessions: {} });
  assert.ok(mgr.mcpConnections().problems.length > 0);
});

test("改名（update）: session の mcpServers（bantou-coordinator の割り当て）は新しい名前に引き継がれ、割り当ては付いたまま。他の session には移らない", async () => {
  const { createMcpSource } = await import("../src/mcp-source.js");
  const { isAssigned } = await import("../src/mcp-session.js");
  await writeFile(join(dir, "sessions.json"), JSON.stringify([rec("a", { instructions: "ia", mcpServers: { "bantou-coordinator": COORD } }), rec("b")]));
  const source = createMcpSource(join(dir, "center-settings.json"), join(dir, "sessions.json"));
  const { mgr } = setup({ mcpSource: source });
  await mgr.restore();
  assert.equal(isAssigned(mgr.mcpConnections().data, "a", "coordinator"), true);
  await mgr.update({ name: "a", newName: "a2" });
  const s = await readJson("sessions.json");
  const a2 = s.find((r: { name: string }) => r.name === "a2");
  assert.deepEqual(a2.settings, { instructions: "ia", mcpServers: { "bantou-coordinator": COORD } }, "mcpServers が消えない");
  const d = mgr.mcpConnections().data;
  assert.equal(isAssigned(d, "a2", "coordinator"), true);
  assert.equal(isAssigned(d, "a", "coordinator"), false);
  assert.equal(isAssigned(d, "b", "coordinator"), false);
  assert.equal(s.find((r: { name: string }) => r.name === "b").settings, undefined);
  // 改名の後にもう一度保存しても保たれる
  await mgr.updateSettings("a2", { instructions: "ia2" });
  assert.deepEqual((await readJson("sessions.json")).find((r: { name: string }) => r.name === "a2").settings.mcpServers, { "bantou-coordinator": COORD });
});

test("updateSettings: servers の範囲が変わった時だけ master-cap へ知らせる（新旧の範囲を載せる）。他の項目だけの更新・同じ範囲では知らせない。知らせに失敗しても更新は成功", async () => {
  const sent: { name: string; text: string }[] = [];
  const { mgr } = setup({ notifyServersChanged: async (name, text) => (sent.push({ name, text }), { ok: false, reason: "届かない" }) });
  await mgr.create({ name: "pm1" });
  await mgr.updateSettings("pm1", { instructions: "x" });
  assert.equal(sent.length, 0);
  assert.deepEqual((await mgr.updateSettings("pm1", { servers: ["host-a"] })).settings.servers, ["host-a"]);
  await mgr.updateSettings("pm1", { servers: ["host-a"] });
  await mgr.updateSettings("pm1", { servers: null });
  assert.equal(sent.length, 2);
  assert.equal(sent[0]!.name, "pm1");
  assert.match(sent[0]!.text, /指定なし（全部） → host-a/);
  assert.match(sent[1]!.text, /host-a → 指定なし（全部）/);
});
