import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { watchSessionInstructions } from "../src/config-watch.js";
import { parseConfig } from "../src/config.js";
import { INSTRUCTIONS_MARK, syncInstructionsFile } from "../src/instructions.js";
import { createSessionManager, type SavedSession } from "../src/sessions.js";
import { createJsonListStore } from "../src/store.js";
import type { RcStatus, RemoteControlSupervisor } from "../src/remote-control.js";
import type { ProjectConfig } from "../src/config.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "center-instr-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const exists = (p: string) => stat(p).then(() => true, () => false);

function fakeSupervisor() {
  const map = new Map<string, RcStatus>();
  const mk = (p: ProjectConfig): RcStatus => ({
    project: p.name, path: p.path, state: "stopped", pid: null, sessionUrl: null, environmentUrl: null,
    restarts: 0, lastExit: null, startedAt: null, args: null, claude: { path: "claude", source: "PATH" },
  });
  return {
    add: (p: ProjectConfig) => void map.set(p.name, mk(p)),
    remove: async (n: string) => void map.delete(n),
    start: async (n: string) => ({ ...map.get(n)!, state: "connected" as const, sessionUrl: "https://x" }),
    status: (n: string) => ({ ...map.get(n)! }),
    list: () => [...map.values()],
  } as unknown as RemoteControlSupervisor;
}

const manager = (sessionInstructions?: string) => {
  const config = parseConfig({ workspace: join(dir, "ws"), ...(sessionInstructions !== undefined ? { sessionInstructions } : {}) }, join(dir, "c.json"));
  const store = createJsonListStore<SavedSession>(join(dir, "sessions.json"), () => {});
  return { mgr: createSessionManager({ config, supervisor: fakeSupervisor(), store, log: () => {}, waitMs: 0 }), store };
};

test("config: sessionInstructions は任意。空文字・空白だけは無しになる", () => {
  assert.equal(parseConfig({}, "/x/c.json").sessionInstructions, undefined);
  assert.equal(parseConfig({ sessionInstructions: "" }, "/x/c.json").sessionInstructions, undefined);
  assert.equal(parseConfig({ sessionInstructions: " \n " }, "/x/c.json").sessionInstructions, undefined);
  assert.equal(parseConfig({ sessionInstructions: "a\nb" }, "/x/c.json").sessionInstructions, "a\nb");
  assert.throws(() => parseConfig({ sessionInstructions: 1 }, "/x/c.json"), /sessionInstructions/);
});

test("syncInstructionsFile: 先頭 1 行に印を付けて書き、手で直しても上書きする", async () => {
  assert.equal(await syncInstructionsFile(dir, "本文"), "written");
  assert.equal(await readFile(join(dir, "CLAUDE.md"), "utf8"), `${INSTRUCTIONS_MARK}\n本文\n`);
  await writeFile(join(dir, "CLAUDE.md"), "手書き");
  await syncInstructionsFile(dir, "本文2\n");
  assert.equal(await readFile(join(dir, "CLAUDE.md"), "utf8"), `${INSTRUCTIONS_MARK}\n本文2\n`);
});

test("syncInstructionsFile: 空なら印のあるファイルを消す。手書きのファイル・無いファイルは触らない", async () => {
  await syncInstructionsFile(dir, "x");
  assert.equal(await syncInstructionsFile(dir, ""), "removed");
  assert.equal(await exists(join(dir, "CLAUDE.md")), false);
  assert.equal(await syncInstructionsFile(dir, undefined), "none");
  await writeFile(join(dir, "CLAUDE.md"), "手書き\n");
  assert.equal(await syncInstructionsFile(dir, undefined), "kept");
  assert.equal(await readFile(join(dir, "CLAUDE.md"), "utf8"), "手書き\n");
  assert.equal(await syncInstructionsFile(join(dir, "nodir"), undefined), "none");
});

test("create: 起動時に <workspace>/<name>/CLAUDE.md を書く。指示が無ければ作らない", async () => {
  const a = manager("指示A");
  const r = await a.mgr.create({ name: "pm1" });
  assert.equal(r.path, join(dir, "ws", "pm1"));
  assert.equal(await readFile(join(r.path, "CLAUDE.md"), "utf8"), `${INSTRUCTIONS_MARK}\n指示A\n`);
  const b = manager();
  const r2 = await b.mgr.create({ name: "pm2" });
  assert.equal(await exists(join(r2.path, "CLAUDE.md")), false);
});

test("setInstructions: 今ある全 session の dir を書き直し、空で消す", async () => {
  const { mgr } = manager("旧");
  const a = await mgr.create({ name: "a" });
  const b = await mgr.create({ name: "b", path: join(dir, "elsewhere") });
  await mgr.setInstructions("新");
  for (const p of [a.path, b.path]) assert.equal(await readFile(join(p, "CLAUDE.md"), "utf8"), `${INSTRUCTIONS_MARK}\n新\n`);
  await mgr.setInstructions(undefined);
  for (const p of [a.path, b.path]) assert.equal(await exists(join(p, "CLAUDE.md")), false);
  // 消した後に作った session にも付かない
  const c = await mgr.create({ name: "c" });
  assert.equal(await exists(join(c.path, "CLAUDE.md")), false);
});

test("setInstructions: dir が消えている session があっても他は書き直す", async () => {
  const { mgr } = manager();
  const a = await mgr.create({ name: "a" });
  const b = await mgr.create({ name: "b" });
  await rm(a.path, { recursive: true });
  await mgr.setInstructions("新");
  assert.equal(await exists(join(b.path, "CLAUDE.md")), true);
});

test("restore: 復帰時にも CLAUDE.md を書く", async () => {
  const { store, mgr } = manager("指示");
  await store.save([{ name: "r", path: join(dir, "ws", "r"), permissionMode: "auto", createdAt: "2026-11-04T00:00:00Z" }]);
  await mgr.restore();
  assert.equal(await readFile(join(dir, "ws", "r", "CLAUDE.md"), "utf8"), `${INSTRUCTIONS_MARK}\n指示\n`);
});

test("watchSessionInstructions: config の更新で指示だけ反映する。同じ内容・壊れた config では呼ばない", async () => {
  const path = join(dir, "center.json");
  await mkdir(dir, { recursive: true });
  await writeFile(path, JSON.stringify({ sessionInstructions: "a" }));
  const got: (string | undefined)[] = [];
  const logs: string[] = [];
  const stop = watchSessionInstructions({ path, initial: "a", onChange: async (t) => void got.push(t), log: (m) => logs.push(m), intervalMs: 20 });
  const until = async (cond: () => boolean) => {
    for (let i = 0; i < 100 && !cond(); i++) await new Promise((r) => setTimeout(r, 20));
  };
  try {
    await writeFile(path, JSON.stringify({ sessionInstructions: "a", workspace: "/w" }));
    await new Promise((r) => setTimeout(r, 150));
    assert.deepEqual(got, []);
    await writeFile(path, JSON.stringify({ sessionInstructions: "b" }));
    await until(() => got.length === 1);
    assert.deepEqual(got, ["b"]);
    await writeFile(path, "{壊れ");
    await until(() => logs.length > 0);
    assert.match(logs[0], /再読込失敗/);
    await writeFile(path, JSON.stringify({}));
    await until(() => got.length === 2);
    assert.deepEqual(got, ["b", undefined]);
  } finally {
    stop();
  }
});
