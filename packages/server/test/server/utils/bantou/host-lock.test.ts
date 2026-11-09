import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { acquireHostLock, conflictMessage, hostLockPath, startToken } from "../../../../bin/host-lock.mjs";

// 本物の /tmp/bantou-server.lock は触らない: 全 test が env BANTOU_SERVER_HOST_LOCK で test 専用 dir の lock に向ける
const cli = fileURLToPath(new URL("../../../fixtures/host-lock-cli.mjs", import.meta.url));

async function withLock(fn: (lock: string, env: NodeJS.ProcessEnv) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "bantou-hostlock-test-"));
  const lock = join(dir, "bantou-server.lock");
  try {
    await fn(lock, { ...process.env, BANTOU_SERVER_HOST_LOCK: lock, BANTOU_SERVER_ALLOW_MULTI: "" });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function hold(env: NodeJS.ProcessEnv): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [cli, "hold"], { env, stdio: ["ignore", "pipe", "inherit"] });
    p.stdout!.setEncoding("utf8");
    p.stdout!.once("data", (d: string) => (d.startsWith("held") ? resolve(p) : reject(new Error(`hold: ${d}`))));
    p.once("error", reject);
  });
}

const exited = (p: ChildProcess): Promise<void> => new Promise((r) => (p.exitCode !== null || p.signalCode !== null ? r() : p.once("exit", () => r())));

test("host lock: 場所は env で差し替えられ、既定は固定の /tmp（user 共通）", () => {
  assert.equal(hostLockPath({ BANTOU_SERVER_HOST_LOCK: "/x/y.lock" }), "/x/y.lock");
  assert.equal(hostLockPath({}), "/tmp/bantou-server.lock");
});

test("host lock: 取得すると pid / user / workspace を持つ 0666 の lock ができ、解放で消える", async () => {
  await withLock(async (lock, env) => {
    const r = acquireHostLock({ env, info: { workspace: "/w" } });
    assert.equal(r.ok, true);
    const body = JSON.parse(readFileSync(lock, "utf8"));
    assert.equal(body.pid, process.pid);
    assert.equal(typeof body.user, "string");
    assert.equal(body.workspace, "/w");
    assert.equal(((await stat(lock)).mode & 0o777).toString(8), "666");
    r.release?.();
    assert.equal(existsSync(lock), false);
  });
});

test("host lock: 自分の lock の再取得は衝突しない（再入）", async () => {
  await withLock(async (_lock, env) => {
    const a = acquireHostLock({ env });
    const b = acquireHostLock({ env });
    assert.equal(a.ok && b.ok, true);
    a.release?.();
  });
});

test("host lock: 競合 — 別 process が持つ間は取れず、message に既存の pid・止め方が出る", async () => {
  await withLock(async (_lock, env) => {
    const holder = await hold(env);
    try {
      const r = acquireHostLock({ env });
      assert.equal(r.ok, false);
      assert.equal(r.holder.pid, holder.pid);
      const msg = conflictMessage(r);
      assert.ok(msg.includes(`pid=${holder.pid}`));
      assert.ok(msg.includes("user="));
      assert.ok(msg.includes("止め方"));
      assert.ok(msg.includes("BANTOU_SERVER_ALLOW_MULTI=1"));
    } finally {
      holder.kill("SIGKILL");
      await exited(holder);
    }
  });
});

test("host lock: 2 つ目の起動は exit code 非 0 で、stderr に既存 pid が出る", async () => {
  await withLock(async (_lock, env) => {
    const holder = await hold(env);
    try {
      const r = spawnSync(process.execPath, [cli, "guard"], { env, encoding: "utf8" });
      assert.notEqual(r.status, 0);
      assert.ok(r.stderr.includes(`pid=${holder.pid}`), r.stderr);
      assert.equal(r.stdout.includes("acquired"), false);
    } finally {
      holder.kill("SIGKILL");
      await exited(holder);
    }
  });
});

test("host lock: env BANTOU_SERVER_ALLOW_MULTI=1 で外せる（取得も解放もしない）", async () => {
  await withLock(async (lock, env) => {
    const holder = await hold(env);
    try {
      const multi = { ...env, BANTOU_SERVER_ALLOW_MULTI: "1" };
      const r = spawnSync(process.execPath, [cli, "guard"], { env: multi, encoding: "utf8" });
      assert.equal(r.status, 0, r.stderr);
      assert.ok(r.stdout.includes("acquired"));
      assert.equal(JSON.parse(await readFile(lock, "utf8")).pid, holder.pid); // 既存の lock は触らない
    } finally {
      holder.kill("SIGKILL");
      await exited(holder);
    }
  });
});

test("host lock: 異常終了（SIGKILL）後の stale lock は pid の生存確認で取り直せる", async () => {
  await withLock(async (lock, env) => {
    const holder = await hold(env);
    const deadPid = holder.pid!;
    holder.kill("SIGKILL");
    await exited(holder);
    assert.equal(JSON.parse(await readFile(lock, "utf8")).pid, deadPid); // 解放されずに残っている
    const r = acquireHostLock({ env });
    assert.equal(r.ok, true);
    assert.equal(JSON.parse(await readFile(lock, "utf8")).pid, process.pid);
    r.release?.();
  });
});

test("host lock: pid が再利用されても起動時刻 token が違えば stale（生きた別 process は持ち主ではない）", async () => {
  await withLock(async (lock, env) => {
    const other = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
    try {
      // 生きている別 process の pid を、違う token 付きで lock に書く = pid 再利用後の状態
      await writeFile(lock, JSON.stringify({ pid: other.pid, user: "x", started_at: "2000-01-01T00:00:00Z", start: "proc:1" }) + "\n");
      const r = acquireHostLock({ env });
      assert.equal(r.ok, true);
      assert.equal(JSON.parse(await readFile(lock, "utf8")).pid, process.pid);
      r.release?.();
      // token が一致するなら生きた持ち主として扱う
      const tok = startToken(other.pid!);
      if (tok !== null) {
        await writeFile(lock, JSON.stringify({ pid: other.pid, user: "x", started_at: "2000-01-01T00:00:00Z", start: tok }) + "\n");
        assert.equal(acquireHostLock({ env }).ok, false);
      }
    } finally {
      other.kill("SIGKILL");
      await exited(other);
    }
  });
});

test("host lock: 壊れた・released の lock は stale として取り直せ、他人の pid の lock は release が消さない", async () => {
  await withLock(async (lock, env) => {
    await writeFile(lock, "not json");
    const a = acquireHostLock({ env });
    assert.equal(a.ok, true);
    a.release?.();
    await writeFile(lock, JSON.stringify({ released: true }) + "\n");
    const b = acquireHostLock({ env });
    assert.equal(b.ok, true);
    await writeFile(lock, JSON.stringify({ pid: 1, user: "root" }) + "\n");
    b.release?.();
    assert.equal(existsSync(lock), true);
  });
});

test("host lock: 持ち主が SIGTERM で正常終了すると lock を解放する", async () => {
  await withLock(async (lock, env) => {
    const holder = await hold(env);
    holder.kill("SIGTERM");
    await exited(holder);
    assert.equal(existsSync(lock), false);
    const r = acquireHostLock({ env });
    assert.equal(r.ok, true);
    r.release?.();
  });
});
