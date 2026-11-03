import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isAlive, readLock, runSupervisor } from "../../../../bin/supervisor.mjs";
import * as oldSupervisor from "../../../fixtures/supervisor-0.3.0.mjs";

const serve = fileURLToPath(new URL("../../../fixtures/fake-serve.mjs", import.meta.url));
const nextBin = fileURLToPath(new URL("../../../fixtures/fake-next.mjs", import.meta.url));
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface Start {
  n: number;
  mode: string;
  pid: number;
  aliveOthers: number;
  lockMatches: boolean;
}

async function withWs(fn: (ws: string, configPath: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "bantou-handoff-test-"));
  try {
    const ws = join(dir, "ws");
    const configPath = join(dir, "config.json");
    await writeFile(configPath, JSON.stringify({ workspace: ws }));
    await fn(ws, configPath);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function starts(ws: string): Promise<Start[]> {
  const text = await readFile(join(ws, "starts.log"), "utf8").catch(() => "");
  return text.split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

async function until(what: string, fn: () => Promise<boolean> | boolean, ms = 15_000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await fn())) {
    if (Date.now() > end) throw new Error(`タイムアウト: ${what}`);
    await sleep(50);
  }
}

const exists = (p: string): Promise<boolean> => stat(p).then(() => true, () => false);

/** 偽の次期 supervisor（fake-next）へ引き継ぐ S2。nextMode で次期の振る舞いを選ぶ。 */
function run(
  ws: string,
  configPath: string,
  plan: string[],
  nextMode: string,
  extra: { readyTimeoutMs?: number; probe?: (spec: string) => Promise<boolean> } = {},
): Promise<number> {
  return runSupervisor({
    configPath,
    selfBin: "unused",
    version: "sup-old",
    command: (spec) => ({ cmd: process.execPath, args: [serve, String(spec)] }),
    nextCommand: (spec) => ({ cmd: process.execPath, args: [nextBin, spec, configPath] }),
    env: { ...process.env, FAKE_WS: ws, FAKE_PLAN: JSON.stringify(plan), FAKE_NEXT_MODE: nextMode },
    log: () => {},
    probe: async () => true,
    readyTimeoutMs: 8000,
    handoffSlackMs: 0,
    ...extra,
  });
}

/** 後始末: lock の持ち主（引き継ぎ後の supervisor）と、残っている偽の子を止める。 */
async function cleanup(ws: string): Promise<void> {
  const lock = readLock(ws);
  const pids = [lock?.pid, lock?.child, lock?.next?.pid, lock?.next?.child, ...(await starts(ws)).map((s) => s.pid)];
  for (const p of pids) {
    if (typeof p === "number" && p !== process.pid && isAlive(p)) {
      try {
        process.kill(p, "SIGKILL");
      } catch {
        // 消えた
      }
    }
  }
}

async function assertRolledBack(ws: string, to: string, trialLabel: RegExp): Promise<void> {
  const lock = readLock(ws);
  assert.equal(lock?.pid, process.pid, "lock は旧 supervisor に戻っている");
  assert.equal(lock?.next, undefined, "next は消えている");
  const f = JSON.parse(await readFile(join(ws, "update.json"), "utf8"));
  assert.equal(f.state, "failed");
  assert.equal(f.to, to);
  assert.match(f.error, trialLabel);
  const s = await starts(ws);
  // 更新前の子 → （試行の子があれば）→ lastGood の子
  assert.equal(s[s.length - 1].mode, "serve", "lastGood の子で起動し直した");
  assert.equal(s[s.length - 1].lockMatches, true);
  assert.equal(s.every((x) => x.aliveOthers === 0), true, "serve の子が同時に 2 本になっていない");
  await until("巻き戻し後の子が ready", () => exists(join(ws, "server.ready")));
  const alive = s.filter((x) => isAlive(x.pid));
  assert.deepEqual(alive.map((x) => x.pid), [s[s.length - 1].pid], "生きている子は巻き戻し先の 1 本だけ（試行側の子が残らない）");
}

test("引き継ぎ（良い次期）: 旧 supervisor は exit 0、lock の持ち主は新 supervisor、子は同時に 2 本にならない", async () => {
  await withWs(async (ws, configPath) => {
    try {
      const code = await run(ws, configPath, ["update:specB", "serve"], "good");
      assert.equal(code, 0);
      const lock = readLock(ws);
      assert.ok(lock);
      assert.notEqual(lock.pid, process.pid, "lock は新 supervisor");
      assert.equal(lock.version, "next-specB");
      assert.equal(isAlive(lock.pid), true, "新 supervisor は生きている");
      assert.equal(lock.next, undefined);
      const s = await starts(ws);
      assert.deepEqual(s.map((x) => x.mode), ["update:specB", "serve"]);
      assert.equal(s.every((x) => x.aliveOthers === 0 && x.lockMatches), true);
      assert.equal(lock.child, s[1].pid, "lock.child は新 supervisor の子");
      assert.equal(isAlive(s[0].pid), false);
      assert.equal(isAlive(s[1].pid), true);
      assert.equal(await exists(join(ws, "update.json")), false, "restart の合図は消えている");
      // 新 supervisor は通常モード: SIGTERM で子を止めて終わり、lock を消す
      process.kill(lock.pid, "SIGTERM");
      await until("新 supervisor の終了", () => !isAlive(lock.pid));
      await until("子の終了", () => !isAlive(s[1].pid));
      assert.equal(await exists(join(ws, "server.lock")), false);
    } finally {
      await cleanup(ws);
    }
  });
});

test("引き継ぎ（lock 前に crash）: 巻き戻し。lock は旧のまま、update.json に failed、lastGood の子で起動し直す", async () => {
  await withWs(async (ws, configPath) => {
    const p = run(ws, configPath, ["update:v2", "serve"], "crash-early");
    try {
      await until("巻き戻し後の子", async () => (await starts(ws)).length === 2 && (await exists(join(ws, "server.ready"))));
      await assertRolledBack(ws, "v-v2", /引き継ぎに失敗/);
      process.emit("SIGTERM");
      assert.equal(await p, 0);
    } finally {
      await cleanup(ws);
    }
  });
});

test("引き継ぎ（lock 後に crash）: 巻き戻し", async () => {
  await withWs(async (ws, configPath) => {
    const p = run(ws, configPath, ["update:v2", "serve"], "crash-after-lock");
    try {
      await until("巻き戻し後の子", async () => (await starts(ws)).length === 2 && (await exists(join(ws, "server.ready"))));
      await assertRolledBack(ws, "v-v2", /引き継ぎに失敗/);
      process.emit("SIGTERM");
      assert.equal(await p, 0);
    } finally {
      await cleanup(ws);
    }
  });
});

test("引き継ぎ（lock 後に SIGKILL）: 試行側の子（孤児）も消して巻き戻す", async () => {
  await withWs(async (ws, configPath) => {
    const p = run(ws, configPath, ["update:v2", "serve", "serve"], "kill-after-lock");
    try {
      await until("巻き戻し後の子", async () => (await starts(ws)).length === 3 && (await exists(join(ws, "update.json"))));
      const s = await starts(ws);
      assert.equal(s[1].mode, "serve", "試行側の子");
      assert.equal(isAlive(s[1].pid), false, "試行側の子は消えている");
      await assertRolledBack(ws, "v-v2", /引き継ぎに失敗/);
      process.emit("SIGTERM");
      assert.equal(await p, 0);
    } finally {
      await cleanup(ws);
    }
  });
});

test("引き継ぎ（hang）: ready にならなければ timeout で次期の系列を止めて巻き戻す", async () => {
  await withWs(async (ws, configPath) => {
    const p = run(ws, configPath, ["update:v2", "serve"], "hang", { readyTimeoutMs: 600 });
    try {
      await until("巻き戻し後の子", async () => (await starts(ws)).length === 2 && (await exists(join(ws, "update.json"))));
      await assertRolledBack(ws, "v-v2", /ms 以内に ready にならない/);
      process.emit("SIGTERM");
      assert.equal(await p, 0);
    } finally {
      await cleanup(ws);
    }
  });
});

test("引き継ぎ（次期の子が ready 前に crash）: 次期が exit 1 して巻き戻す。試行側の子は残らない", async () => {
  await withWs(async (ws, configPath) => {
    // 子の計画: 更新前の子 → 試行の子（crash）→ 巻き戻し先
    const p = run(ws, configPath, ["update:v2", "crash", "serve"], "good");
    try {
      await until("巻き戻し後の子", async () => (await starts(ws)).length === 3 && (await exists(join(ws, "update.json"))));
      const s = await starts(ws);
      assert.deepEqual(s.map((x) => x.mode), ["update:v2", "crash", "serve"]);
      await assertRolledBack(ws, "v-v2", /引き継ぎに失敗/);
      process.emit("SIGTERM");
      assert.equal(await p, 0);
    } finally {
      await cleanup(ws);
    }
  });
});

test("引き継ぎ中の停止: 次期の系列を片付け、巻き戻し（failed）扱いにせず lock を消して exit 0", async () => {
  await withWs(async (ws, configPath) => {
    const p = run(ws, configPath, ["update:v2", "serve"], "hang");
    try {
      await until("次期が lock に載る", () => typeof readLock(ws)?.next?.pid === "number");
      const nextPid = readLock(ws)?.next?.pid as number;
      assert.equal(isAlive(nextPid), true);
      process.emit("SIGTERM");
      assert.equal(await p, 0);
      assert.equal(isAlive(nextPid), false, "次期は止まっている");
      assert.equal(await exists(join(ws, "server.lock")), false);
      const upd = await readFile(join(ws, "update.json"), "utf8").catch(() => "");
      assert.doesNotMatch(upd, /failed/);
      assert.equal((await starts(ws)).length, 1, "巻き戻しの子は起動しない");
    } finally {
      await cleanup(ws);
    }
  });
});

test("probe 失敗（引き継ぎ非対応の版）: 従来どおり子だけ入れ替える。lock の持ち主は変わらない", async () => {
  await withWs(async (ws, configPath) => {
    const p = run(ws, configPath, ["update:v2", "serve"], "good", { probe: async () => false });
    try {
      await until("2 本目の子が ready", async () => (await starts(ws)).length === 2 && (await exists(join(ws, "server.ready"))));
      const lock = readLock(ws);
      assert.equal(lock?.pid, process.pid);
      assert.equal(lock?.next, undefined);
      assert.deepEqual((await starts(ws)).map((x) => x.mode), ["update:v2", "serve"]);
      process.emit("SIGTERM");
      assert.equal(await p, 0);
    } finally {
      await cleanup(ws);
    }
  });
});

test("互換: 0.3.0 の supervisor の下でも、新版の子は動く（assertServeAllowed / ready / update.json の restart で子だけ入れ替わる）", async () => {
  await withWs(async (ws, configPath) => {
    const p = oldSupervisor.runSupervisor({
      configPath,
      selfBin: "unused",
      version: "0.3.0",
      command: (spec: string | null) => ({ cmd: process.execPath, args: [serve, String(spec)] }),
      env: { ...process.env, FAKE_WS: ws, FAKE_PLAN: JSON.stringify(["update:v2", "serve"]) },
      log: () => {},
    });
    try {
      await until("2 本目の子が ready", async () => (await starts(ws)).length === 2 && (await exists(join(ws, "server.ready"))));
      const s = await starts(ws);
      assert.deepEqual(s.map((x) => x.mode), ["update:v2", "serve"], "rejected なら assertServeAllowed が旧 lock を通していない");
      assert.equal(s.every((x) => x.lockMatches && x.aliveOthers === 0), true);
      const lock = readLock(ws);
      assert.equal(lock?.pid, process.pid, "旧 supervisor のまま（pid 不変）");
      assert.equal(lock?.launcher, undefined);
      process.emit("SIGTERM");
      assert.equal(await p, 0);
    } finally {
      await cleanup(ws);
    }
  });
});
