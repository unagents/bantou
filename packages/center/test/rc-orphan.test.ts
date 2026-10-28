/**
 * 再現テスト: center を SIGKILL → remote-control（stub）が ppid=1 で残る →
 * 次の center の起動で孤児とその孫が回収され、新しい stub が 1 本だけ起動する。
 * 実 claude は使わない。後始末は記録した pid / pgid だけを kill する（pkill -f は使わない）。
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { listProcesses } from "../src/reap.js";

const centerDir = fileURLToPath(new URL("..", import.meta.url));
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const recorded = new Set<number>(); // 後始末用に記録した pid（stub / 孫 / center）
let root = "";

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
};

async function waitFor<T>(what: string, ms: number, fn: () => T | undefined | Promise<T | undefined>): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v !== undefined) return v;
    if (Date.now() > end) throw new Error(`タイムアウト: ${what}`);
    await sleep(50);
  }
}

after(async () => {
  for (const pid of recorded) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* 既に居ない */
    }
  }
  if (root) await rm(root, { recursive: true, force: true });
});

// stub: 受けた signal を STUB_SIGLOG に追記、100ms 後に Connected、孫を 1 本起動（pid を STUB_GCLOG に追記）
const STUB = `#!/usr/bin/env node
const { spawn } = require("node:child_process");
const fs = require("node:fs");
for (const s of ["SIGTERM", "SIGHUP"]) process.on(s, () => { fs.appendFileSync(process.env.STUB_SIGLOG, process.pid + " " + s + "\\n"); process.exit(0); });
const gc = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)", "grandchild-of-" + process.argv.slice(2).join("_")], { stdio: "ignore" });
fs.appendFileSync(process.env.STUB_GCLOG, process.pid + " " + gc.pid + "\\n");
setTimeout(() => console.log("Connected"), 100);
setInterval(() => {}, 1000);
`;

function startCenter(cfg: string, logs: string[]): ChildProcess {
  const c = spawn(
    process.execPath,
    ["--import", "tsx", "src/cli.ts", "--config", cfg, "--transport", "http", "--port", "0"],
    { cwd: centerDir, stdio: ["ignore", "pipe", "pipe"] },
  );
  if (c.pid) recorded.add(c.pid);
  c.stderr?.setEncoding("utf8");
  c.stderr?.on("data", (d: string) => logs.push(d));
  return c;
}

const stubPidFromLog = (logs: string[], nth: number): number | undefined => {
  const all = [...logs.join("").matchAll(/remote-control 起動: project=\S+ pid=(\d+)/g)];
  return all[nth] ? Number(all[nth][1]) : undefined;
};

test("center を SIGKILL すると rc が孤児で残り、次の center の起動で回収される", { timeout: 60_000 }, async () => {
  root = await mkdtemp(join(tmpdir(), "rc-orphan-"));
  const project = `orph-${randomBytes(4).toString("hex")}`;
  const projPath = join(root, "proj");
  await mkdir(projPath, { recursive: true });
  const stub = join(root, "claude-stub.js");
  await writeFile(stub, STUB);
  await chmod(stub, 0o755);
  const sigLog = join(root, "sig.log");
  const gcLog = join(root, "gc.log");
  await writeFile(sigLog, "");
  await writeFile(gcLog, "");
  const cfg = join(root, "center.json");
  await writeFile(
    cfg,
    JSON.stringify({
      projects: [{ name: project, path: projPath, autostart: true }],
      remoteControl: { claude: stub, stopGraceMs: 1000, env: { STUB_SIGLOG: sigLog, STUB_GCLOG: gcLog } },
      logDir: join(root, "logs"),
      token: "orphan-test-token-0123",
    }),
  );

  // 1) center A を起動し stub の起動を確認、その後 SIGKILL
  const logsA: string[] = [];
  const a = startCenter(cfg, logsA);
  const stubA = await waitFor("stub A 起動", 20_000, () => stubPidFromLog(logsA, 0));
  recorded.add(stubA);
  const gcA = await waitFor("孫 A 起動", 10_000, () => {
    const line = readFileSync(gcLog, "utf8").split("\n").find((l) => l.startsWith(`${stubA} `));
    return line ? Number(line.split(" ")[1]) : undefined;
  });
  recorded.add(gcA);
  a.kill("SIGKILL");
  await new Promise<void>((r) => a.once("exit", () => r()));

  // 2) 孤児が残る（stub A 生存・ppid=1。判定できなければ skip でなく fail）
  const orphanProc = await waitFor("stub A が ppid=1 で残る", 10_000, async () => {
    const procs = await listProcesses();
    assert.ok(procs, "ps が使えない");
    return procs.find((p) => p.pid === stubA && p.ppid === 1);
  });
  assert.ok(alive(stubA), "stub A が死んでいる（孤児が再現できない）");
  assert.ok(alive(gcA), "孫 A が死んでいる");
  assert.equal(orphanProc.pgid, stubA, "detached で pgid=stub の pid になっていない");

  // 3) center B 起動 → 孤児を回収して新しい stub を 1 本起動
  const logsB: string[] = [];
  const b = startCenter(cfg, logsB);
  const stubB = await waitFor("stub B 起動", 20_000, () => stubPidFromLog(logsB, 0));
  recorded.add(stubB);
  await waitFor("旧 stub A が消える", 10_000, () => (alive(stubA) ? undefined : true));
  await waitFor("旧孫 A が消える", 10_000, () => (alive(gcA) ? undefined : true));
  assert.notEqual(stubB, stubA);
  assert.ok(alive(stubB), "新 stub B が生きていない");
  assert.match(logsB.join(""), /孤児回収: SIGTERM/);
  assert.match(readFileSync(sigLog, "utf8"), new RegExp(`^${stubA} SIGTERM$`, "m"));

  // 4) 重複していない: 同 project の rc は B 1 本だけ（name に乱数を含むので他と混ざらない。stub は argv に --name を持つ）
  const procs = await listProcesses();
  assert.ok(procs);
  const rcs = procs.filter((p) => p.pid !== process.pid && /\bremote-control\b/.test(p.command) && p.command.split(/\s+/).includes(project));
  assert.deepEqual(rcs.map((p) => p.pid), [stubB]);

  // 5) 正常停止（SIGTERM）では子と孫が残らない
  b.kill("SIGTERM");
  await new Promise<void>((r) => b.once("exit", () => r()));
  await waitFor("stub B が消える", 10_000, () => (alive(stubB) ? undefined : true));
  assert.ok(existsSync(join(root, "logs", "center.log")), "center.log が無い");
});
