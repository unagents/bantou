import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { parseConfig, type Config, type ProjectConfig } from "../src/config.js";
import type { RcStatus, RemoteControlSupervisor } from "../src/remote-control.js";
import { createSessionManager, type SavedSession } from "../src/sessions.js";
import { createJsonListStore } from "../src/store.js";

/** supervisor の偽物。add / remove / start / list / status だけ持つ。 */
function fakeSupervisor(initial: ProjectConfig[]) {
  const map = new Map<string, RcStatus>();
  const calls: string[] = [];
  const mk = (p: ProjectConfig): RcStatus => ({
    project: p.name, path: p.path, state: "stopped", pid: null, sessionUrl: null, environmentUrl: null,
    restarts: 0, lastExit: null, startedAt: null, args: null, claude: { path: "claude", source: "PATH" },
  });
  for (const p of initial) map.set(p.name, mk(p));
  const sup = {
    add: (p: ProjectConfig) => {
      if (map.has(p.name)) throw new Error("既に存在");
      calls.push(`add:${p.name}:${p.permissionMode}`);
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
      s.sessionUrl = `https://claude.ai/code/session_${n}`;
      return { ...s };
    },
    status: (n: string) => ({ ...map.get(n)! }),
    list: () => [...map.values()].map((s) => ({ ...s })),
  } as unknown as RemoteControlSupervisor;
  return { sup, calls };
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

const setup = () => {
  const fs = fakeSupervisor(config.projects);
  const store = createJsonListStore<SavedSession>(join(dir, "sessions.json"), () => {});
  const mgr = createSessionManager({ config, supervisor: fs.sup, store, log: () => {}, waitMs: 0 });
  return { ...fs, store, mgr };
};

test("create: path 省略は <workspace>/<name> を作り、起動して保存する。config の projects には書かない", async () => {
  const { mgr, calls } = setup();
  const r = await mgr.create({ name: "pm1" });
  assert.equal(r.path, join(dir, "ws", "pm1"));
  assert.ok((await stat(r.path)).isDirectory());
  assert.equal(r.state, "connected");
  assert.equal(r.source, "session");
  assert.deepEqual(calls, ["add:pm1:auto", "start:pm1"]);
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
  assert.ok(calls.includes("add:a:plan"));
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
  assert.deepEqual(calls, ["add:pm1:auto", "start:pm1:resume", "add:pm3:plan", "start:pm3:resume"]);
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
