import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// 本物の bin/（bantou.mjs → launcher → supervisor → --serve）を test 用 dir にコピーし、常駐本体（.output/server/index.mjs）だけを偽物に差し替えて
// 「退役した子が exit 76 → supervisor → server.exit → launcher → process の exit 76」「host lock・server.lock の解放」「再起動の拒否」を確かめる。
// 本物の /tmp/bantou-server.lock と常駐 server には触らない（host lock は env で test 専用 dir に向ける）。
const binDir = fileURLToPath(new URL("../../../../bin/", import.meta.url));
const exists = (p: string): Promise<boolean> => stat(p).then(() => true, () => false);

const fakeServe = `
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const cfg = JSON.parse(readFileSync(process.env.NUXT_BANTOU_CONFIG_PATH, "utf8"));
const ws = cfg.workspace;
appendFileSync(join(ws, "starts.log"), process.pid + "\\n");
writeFileSync(join(ws, "server.ready"), JSON.stringify({ pid: process.pid, version: "fake" }));
if (process.env.FAKE_MODE === "retire") {
  // 本物の daemon と同じ順序: 印 → (停止) → exit 76
  setTimeout(() => {
    writeFileSync(join(ws, "server.retired"), "{}");
    process.exit(76);
  }, 300);
} else {
  setInterval(() => {}, 1000);
  process.on("SIGTERM", () => process.exit(0));
}
`;

async function withInstall(fn: (i: { run: (mode: string) => ReturnType<typeof spawnSync>; ws: string; hostLock: string; starts: () => Promise<number> }) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "bantou-retire-chain-"));
  try {
    const pkg = join(dir, "pkg");
    await mkdir(join(pkg, "bin"), { recursive: true });
    await mkdir(join(pkg, ".output", "server"), { recursive: true });
    for (const f of ["bantou.mjs", "launcher.mjs", "supervisor.mjs", "host-lock.mjs", "default-config.mjs"]) await copyFile(join(binDir, f), join(pkg, "bin", f));
    await writeFile(join(pkg, "package.json"), JSON.stringify({ name: "bantou", version: "0.0.0-test", type: "module" }));
    await writeFile(join(pkg, ".output", "server", "index.mjs"), fakeServe);
    const ws = join(dir, "ws");
    await mkdir(ws);
    const config = join(dir, "config.json");
    await writeFile(config, JSON.stringify({ workspace: ws }));
    const hostLock = join(dir, "host.lock");
    const run = (mode: string) =>
      spawnSync(process.execPath, [join(pkg, "bin", "bantou.mjs"), "--config", config], {
        env: { ...process.env, BANTOU_SERVER_HOST_LOCK: hostLock, BANTOU_SERVER_ALLOW_MULTI: "", FAKE_MODE: mode },
        encoding: "utf8",
        timeout: 60_000,
      });
    const starts = async (): Promise<number> => (await readFile(join(ws, "starts.log"), "utf8").catch(() => "")).split("\n").filter(Boolean).length;
    await fn({ run, ws, hostLock, starts });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("退役: 子の exit 76 が supervisor → server.exit → launcher を通って process の exit 76 になり、lock が全て解放され、戻らない", async () => {
  await withInstall(async ({ run, ws, hostLock, starts }) => {
    const r = run("retire");
    assert.equal(r.status, 76, `${r.stdout}\n${r.stderr}`);
    assert.equal(await starts(), 1, "子は 1 回だけ起動");
    assert.ok(await exists(join(ws, "server.retired")), "印が残る");
    assert.ok(!(await exists(join(ws, "server.lock"))), "server.lock は解放済み");
    assert.ok(!(await exists(hostLock)), "host lock は解放済み");
    const fin = JSON.parse(await readFile(join(ws, "server.exit"), "utf8"));
    assert.equal(fin.code, 76);

    // unit の Restart が起動し直した想定: 印があるので launcher を起動せず exit 75（旧 unit も 75 は再起動しない）。子は起動しない
    const again = run("serve");
    assert.equal(again.status, 75, `${again.stdout}\n${again.stderr}`);
    assert.match(String(again.stderr), /退役済み/);
    assert.equal(await starts(), 1, "退役後は子を起動しない");
    assert.ok(!(await exists(hostLock)), "拒否した起動も host lock を残さない");

    // 印を消せば再び使える（再有効化の手順）
    await unlink(join(ws, "server.retired"));
    const back = run("retire");
    assert.equal(back.status, 76, `${back.stdout}\n${back.stderr}`);
    assert.equal(await starts(), 2);
  });
});

test("退役でない通常の終了（子が SIGTERM で exit 0）は印を作らず、次も起動できる", async () => {
  await withInstall(async ({ ws, starts }) => {
    // serve は居座るので、起動直後に launcher へ SIGTERM を送る代わりに、印の無い workspace で retire 以外の mode が起動することだけ確かめる
    const { spawn } = await import("node:child_process");
    const cfg = join(ws, "..", "config.json");
    const p = spawn(process.execPath, [join(ws, "..", "pkg", "bin", "bantou.mjs"), "--config", cfg], {
      env: { ...process.env, BANTOU_SERVER_HOST_LOCK: join(ws, "..", "host.lock"), BANTOU_SERVER_ALLOW_MULTI: "", FAKE_MODE: "serve" },
      stdio: "ignore",
    });
    const end = Date.now() + 20_000;
    while ((await starts()) < 1 && Date.now() < end) await new Promise((r) => setTimeout(r, 100));
    assert.equal(await starts(), 1);
    p.kill("SIGTERM");
    const code: number | null = await new Promise((r) => p.once("exit", (c) => r(c)));
    assert.equal(code, 0);
    assert.ok(!(await exists(join(ws, "server.retired"))));
  });
});
