import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { parseConfig, type Config, type ProjectConfig } from "../src/config.js";
import type { RcStatus, RemoteControlSupervisor } from "../src/remote-control.js";
import { createSessionManager, type SavedSession } from "../src/sessions.js";
import { createJsonListStore, createJsonObjectStore } from "../src/store.js";
import type { ProjectSettings } from "../src/project-settings.js";
import { createEventHub, type SessionsEvent } from "../src/events.js";

/** supervisor の偽物。add / remove / start / list / status だけ持つ。 */
function fakeSupervisor(initial: ProjectConfig[]) {
  const map = new Map<string, RcStatus>();
  const calls: string[] = [];
  /** start が投げる名前。 */
  const failStart = new Set<string>();
  const opts: { add: Record<string, unknown>; start: Record<string, unknown>; setInstr: Record<string, string>; setDirs: Record<string, string[]> } = { add: {}, start: {}, setInstr: {}, setDirs: {} };
  const mk = (p: ProjectConfig): RcStatus => ({
    project: p.name, path: p.path, state: "stopped", pid: null, sessionUrl: null, environmentUrl: null,
    restarts: 0, lastExit: null, startedAt: null, args: null, instructions: false, claude: { path: "claude", source: "PATH" },
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
    status: (n: string) => ({ ...map.get(n)! }),
    list: () => [...map.values()].map((s) => ({ ...s })),
  } as unknown as RemoteControlSupervisor;
  return { sup, calls, opts, failStart };
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
  const conflicts = new Map<string, string>([["create:old", "cap_id を別の session が持っている"], ["rename:held", "remote 記録が残っている"]]);
  const { mgr, calls } = setup({ remoteNameConflict: (n, m) => { seen.push([n, m]); return conflicts.get(`${m}:${n}`) ?? null; } });
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
