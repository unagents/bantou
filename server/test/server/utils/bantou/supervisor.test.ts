import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  acquireLock,
  assertServeAllowed,
  defaultCommand,
  isAlive,
  readWorkspace,
  runSupervisor,
} from "../../../../bin/supervisor.mjs";

const fixture = fileURLToPath(new URL("../../../fixtures/fake-serve.mjs", import.meta.url));
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function withWs(fn: (ws: string, configPath: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "bantou-sup-test-"));
  try {
    const ws = join(dir, "ws");
    const configPath = join(dir, "config.json");
    await writeFile(configPath, JSON.stringify({ workspace: ws }));
    await fn(ws, configPath);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function starts(ws: string): Promise<Array<{ n: number; mode: string; pid: number; readyAtStart: boolean; lockMatches: boolean }>> {
  const text = await readFile(join(ws, "starts.log"), "utf8").catch(() => "");
  return text.split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

async function until(what: string, fn: () => Promise<boolean>, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await fn())) {
    if (Date.now() > end) throw new Error(`タイムアウト: ${what}`);
    await sleep(50);
  }
}

/** FAKE_PLAN の振る舞いで動く偽の子を使う supervisor。spec はそのまま子の第 1 引数（ログ用）になる。 */
function run(ws: string, configPath: string, plan: string[], extra: { readyTimeoutMs?: number; pid?: number } = {}): Promise<number> {
  return runSupervisor({
    configPath,
    selfBin: "unused",
    version: "0.0.0-test",
    command: (spec) => ({ cmd: process.execPath, args: [fixture, String(spec)] }),
    env: { ...process.env, FAKE_WS: ws, FAKE_PLAN: JSON.stringify(plan) },
    log: () => {},
    ...extra,
  });
}

test("defaultCommand: 自分は node <bin> --serve、更新後は npx -y --package=<spec> -- bantou --serve", () => {
  const c = defaultCommand("/p/bin/bantou.mjs", "/c.json");
  assert.deepEqual(c(null), { cmd: process.execPath, args: ["/p/bin/bantou.mjs", "--serve", "--config", "/c.json"] });
  assert.deepEqual(c("bantou@0.3.1"), {
    cmd: "npx",
    args: ["-y", "--package=bantou@0.3.1", "--", "bantou", "--serve", "--config", "/c.json"],
  });
});

test("readWorkspace: workspace は絶対パスの文字列のみ", async () => {
  await withWs(async (ws, configPath) => {
    assert.equal(readWorkspace(configPath), ws);
    const bad = join(ws, "..", "bad.json");
    await writeFile(bad, JSON.stringify({ workspace: "rel" }));
    assert.throws(() => readWorkspace(bad), /絶対パス/);
    await writeFile(bad, "{}");
    assert.throws(() => readWorkspace(bad), /必須/);
    assert.throws(() => readWorkspace(join(ws, "..", "none.json")), /読めない/);
  });
});

test("lock: 排他。生きている pid があれば拒否、死んだ pid は取り直す、解放で消える", async () => {
  await withWs(async (ws) => {
    const release = acquireLock(ws, "1.0.0", process.pid);
    assert.equal(JSON.parse(await readFile(join(ws, "server.lock"), "utf8")).pid, process.pid);
    // 親 pid（生きている別プロセス）は拒否される
    assert.throws(() => acquireLock(ws, "1.0.0", process.pid + 100000), /既に起動中 pid=/);
    release();
    await assert.rejects(stat(join(ws, "server.lock")));
    // 死んだ pid の lock は取り直す
    await mkdir(ws, { recursive: true });
    await writeFile(join(ws, "server.lock"), JSON.stringify({ pid: 2 ** 22 + 12345, version: "x", started_at: "" }));
    assert.equal(isAlive(2 ** 22 + 12345), false);
    const release2 = acquireLock(ws, "1.0.0", process.pid);
    release2();
  });
});

test("assertServeAllowed: BANTOU_SUPERVISOR_PID が lock の pid と一致する時だけ通る", async () => {
  await withWs(async (ws) => {
    assert.throws(() => assertServeAllowed(ws, {}), /supervisor 経由/);
    const release = acquireLock(ws, "1.0.0", process.pid);
    assertServeAllowed(ws, { BANTOU_SUPERVISOR_PID: String(process.pid) });
    assert.throws(() => assertServeAllowed(ws, { BANTOU_SUPERVISOR_PID: "1" }), /supervisor 経由/);
    assert.throws(() => assertServeAllowed(ws, {}), /supervisor 経由/);
    release();
  });
});

test("supervisor: 子の exit code で終わり、lock を消す。lock は子から見て supervisor の pid", async () => {
  await withWs(async (ws, configPath) => {
    const code = await run(ws, configPath, ["exit:7"]);
    assert.equal(code, 7);
    const s = await starts(ws);
    assert.equal(s.length, 1);
    assert.equal(s[0].lockMatches, true);
    await assert.rejects(stat(join(ws, "server.lock")));
  });
});

test("supervisor: 二重起動は拒否（既に起動中）", async () => {
  await withWs(async (ws, configPath) => {
    const p = run(ws, configPath, ["serve"]);
    await until("1 本目の子", async () => (await starts(ws)).length === 1);
    // 同じ process 内なので 2 本目は別の（生きている）pid を名乗る
    await assert.rejects(run(ws, configPath, ["serve"], { pid: process.ppid }), /既に起動中/);
    assert.equal((await starts(ws)).length, 1);
    process.emit("SIGTERM");
    assert.equal(await p, 0);
  });
});

test("supervisor: SIGTERM は子へ中継され、子が終わったら exit 0。子は残らない", async () => {
  await withWs(async (ws, configPath) => {
    const p = run(ws, configPath, ["serve"]);
    await until("子が ready", async () => (await starts(ws)).length === 1 && (await stat(join(ws, "server.ready")).then(() => true, () => false)));
    const pid = (await starts(ws))[0].pid;
    assert.equal(isAlive(pid), true);
    process.emit("SIGTERM");
    assert.equal(await p, 0);
    await until("子の終了", async () => !isAlive(pid));
    await assert.rejects(stat(join(ws, "server.lock")));
  });
});

test("supervisor: update.json の restart で子だけ入れ替える（前の子が消えてから次を起動、常に 1 本）", async () => {
  await withWs(async (ws, configPath) => {
    const p = run(ws, configPath, ["update:specB", "serve"]);
    await until("2 本目の子", async () => (await starts(ws)).length === 2);
    await until("2 本目が ready", async () => {
      const r = await readFile(join(ws, "server.ready"), "utf8").catch(() => "");
      return r !== "" && JSON.parse(r).pid === (await starts(ws))[1].pid;
    });
    const s = await starts(ws);
    assert.deepEqual(s.map((x) => x.mode), ["update:specB", "serve"]);
    assert.notEqual(s[0].pid, s[1].pid);
    assert.equal(isAlive(s[0].pid), false, "前の子は消えている");
    assert.equal(s[1].readyAtStart, false, "次の子の起動時に前の ready は残っていない");
    assert.equal(s.every((x) => x.lockMatches), true);
    // 更新後の子が ready になったら restart の合図は消える
    await until("update.json が消える", async () => !(await stat(join(ws, "update.json")).then(() => true, () => false)));
    process.emit("SIGTERM");
    assert.equal(await p, 0);
  });
});

test("supervisor: 更新後の子が ready 前に終了したら直前の版へ巻き戻し、update.json に failed を書く", async () => {
  await withWs(async (ws, configPath) => {
    const p = run(ws, configPath, ["update:bad", "crash", "serve"]);
    await until("巻き戻した子", async () => (await starts(ws)).length === 3);
    await until("ready", async () => (await stat(join(ws, "server.ready")).then(() => true, () => false)));
    const s = await starts(ws);
    assert.deepEqual(s.map((x) => x.mode), ["update:bad", "crash", "serve"]);
    const f = JSON.parse(await readFile(join(ws, "update.json"), "utf8"));
    assert.equal(f.state, "failed");
    assert.equal(f.to, "v-bad", "failed の to は spec でなく版（center が版で照合する）");
    assert.match(f.error, /ready 前に終了/);
    process.emit("SIGTERM");
    assert.equal(await p, 0);
  });
});

test("supervisor: 更新後の子が ready にならない（timeout）なら止めて巻き戻す", async () => {
  await withWs(async (ws, configPath) => {
    const p = run(ws, configPath, ["update:slow", "hang", "serve"], { readyTimeoutMs: 400 });
    await until("巻き戻した子", async () => (await starts(ws)).length === 3, 15_000);
    const s = await starts(ws);
    assert.deepEqual(s.map((x) => x.mode), ["update:slow", "hang", "serve"]);
    assert.equal(isAlive(s[1].pid), false, "ready にならなかった子は止めた");
    const f = JSON.parse(await readFile(join(ws, "update.json"), "utf8"));
    assert.equal(f.state, "failed");
    assert.equal(f.to, "v-slow");
    assert.match(f.error, /ready にならない/);
    process.emit("SIGTERM");
    assert.equal(await p, 0);
  });
});
