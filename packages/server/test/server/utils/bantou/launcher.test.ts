import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isAlive, readLock } from "../../../../bin/supervisor.mjs";
import { runLauncher } from "../../../../bin/launcher.mjs";

const fakeSupervise = fileURLToPath(new URL("../../../fixtures/fake-supervise.mjs", import.meta.url));
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function withWs(fn: (ws: string, configPath: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "bantou-launcher-test-"));
  try {
    const ws = join(dir, "ws");
    const configPath = join(dir, "config.json");
    await writeFile(configPath, JSON.stringify({ workspace: ws }));
    await fn(ws, configPath);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function until(what: string, fn: () => Promise<boolean> | boolean, ms = 15_000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await fn())) {
    if (Date.now() > end) throw new Error(`タイムアウト: ${what}`);
    await sleep(50);
  }
}

async function starts(ws: string): Promise<Array<{ pid: number; mode: string }>> {
  const text = await readFile(join(ws, "starts.log"), "utf8").catch(() => "");
  return text.split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

const exists = (p: string): Promise<boolean> => stat(p).then(() => true, () => false);

function launch(ws: string, configPath: string, plan: string[], extraEnv: Record<string, string> = {}, pid?: number): Promise<number> {
  return runLauncher({
    configPath,
    selfBin: fakeSupervise,
    pollMs: 50,
    log: () => {},
    env: { ...process.env, FAKE_WS: ws, FAKE_PLAN: JSON.stringify(plan), ...extraEnv },
    ...(pid !== undefined ? { pid } : {}),
  });
}

async function killAll(ws: string): Promise<void> {
  const lock = readLock(ws);
  for (const p of [lock?.pid, lock?.child, ...(await starts(ws)).map((s) => s.pid)]) {
    if (typeof p === "number" && p !== process.pid && isAlive(p)) {
      try {
        process.kill(p, "SIGKILL");
      } catch {
        // 消えた
      }
    }
  }
}

test("launcher: supervisor に env BANTOU_LAUNCHER_PID を付けて起動し、SIGTERM を中継、子の終了で exit 0", async () => {
  await withWs(async (ws, configPath) => {
    try {
      const p = launch(ws, configPath, ["serve"]);
      await until("lock", () => readLock(ws)?.launcher !== undefined);
      assert.equal(readLock(ws)?.launcher, process.pid, "lock.launcher は launcher の pid");
      await until("子が ready", () => exists(join(ws, "server.ready")));
      const sup = readLock(ws)?.pid as number;
      assert.notEqual(sup, process.pid);
      process.emit("SIGTERM");
      assert.equal(await p, 0);
      assert.equal(isAlive(sup), false, "supervisor は終わっている");
      assert.equal((await starts(ws)).every((s) => !isAlive(s.pid)), true, "子も残らない");
      assert.equal(await exists(join(ws, "server.lock")), false);
    } finally {
      await killAll(ws);
    }
  });
});

test("launcher: supervisor の終了コードが server.exit 経由で launcher の終了コードになる", async () => {
  await withWs(async (ws, configPath) => {
    const code = await launch(ws, configPath, ["exit:7"]);
    assert.equal(code, 7);
    assert.deepEqual(JSON.parse(await readFile(join(ws, "server.exit"), "utf8")), { launcher: process.pid, code: 7 });
  });
});

test("launcher: supervisor が引き継いで入れ替わっても残り、系列が消えてから server.exit の code で終わる。信号は新 supervisor に中継される", async () => {
  await withWs(async (ws, configPath) => {
    try {
      let settled = false;
      const p = launch(ws, configPath, ["update:v2", "serve"], { FAKE_NEXT: "1" }).then((c) => {
        settled = true;
        return c;
      });
      const first = (): number | undefined => readLock(ws)?.pid;
      await until("最初の supervisor", () => first() !== undefined);
      const s1 = first() as number;
      await until("引き継ぎ", () => readLock(ws)?.pid !== undefined && readLock(ws)?.pid !== s1 && (readLock(ws)?.version ?? "").startsWith("next-"));
      const s3 = readLock(ws)?.pid as number;
      await until("最初の supervisor の終了", () => !isAlive(s1));
      assert.equal(readLock(ws)?.launcher, process.pid, "引き継ぎ後も lock.launcher は同じ launcher");
      await sleep(400);
      assert.equal(settled, false, "launcher は新 supervisor がいる間は残る");
      await until("新 supervisor の子が ready", () => exists(join(ws, "server.ready")));
      process.emit("SIGTERM"); // launcher が lock.pid（新 supervisor）へ中継する
      assert.equal(await p, 0);
      assert.equal(isAlive(s3), false);
      assert.equal((await starts(ws)).every((s) => !isAlive(s.pid)), true);
    } finally {
      await killAll(ws);
    }
  });
});

test("launcher: 二重起動は 2 本目の supervisor が exit 1、2 本目の launcher も exit 1。1 本目は影響を受けない", async () => {
  await withWs(async (ws, configPath) => {
    try {
      const p1 = launch(ws, configPath, ["serve"]);
      await until("1 本目の子が ready", () => exists(join(ws, "server.ready")));
      const sup1 = readLock(ws)?.pid as number;
      const code2 = await launch(ws, configPath, ["serve"], {}, 2 ** 22 + 99);
      assert.equal(code2, 1);
      assert.equal(readLock(ws)?.pid, sup1);
      assert.equal(isAlive(sup1), true);
      assert.equal((await starts(ws)).length, 1, "2 本目の子は起動していない");
      process.emit("SIGTERM");
      assert.equal(await p1, 0);
    } finally {
      await killAll(ws);
    }
  });
});
