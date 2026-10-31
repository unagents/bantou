// 引き継ぎテスト用の偽の次期 supervisor（`--supervise` の代わり）。argv: <spec> <configPath>。
// FAKE_NEXT_MODE: good（本物の runSupervisor を試行モードで動かす）/ crash-early（lock に触れず exit 1）/
//   crash-after-lock（next.pid を書いて exit 1）/ kill-after-lock（next.pid と子を書き、子が ready になったら自分を SIGKILL）/ hang（next.pid を書いて居座る）
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readLock, readWorkspace, runSupervisor, writeLock } from "../../bin/supervisor.mjs";

const [spec, configPath] = process.argv.slice(2);
const mode = process.env.FAKE_NEXT_MODE ?? "good";
const serve = fileURLToPath(new URL("./fake-serve.mjs", import.meta.url));
const ws = readWorkspace(configPath);
const token = process.env.BANTOU_HANDOFF_TOKEN;

const patchNext = (patch) => {
  const cur = readLock(ws);
  writeLock(ws, { ...cur, next: { ...cur.next, ...patch } });
};

if (mode === "crash-early") process.exit(1);
else if (mode === "crash-after-lock") {
  patchNext({ pid: process.pid, version: `next-${spec}` });
  process.exit(1);
} else if (mode === "hang") {
  patchNext({ pid: process.pid, version: `next-${spec}` });
  setInterval(() => {}, 1000);
} else if (mode === "kill-after-lock") {
  patchNext({ pid: process.pid, version: `next-${spec}` });
  const child = spawn(process.execPath, [serve, "next"], {
    detached: true,
    stdio: "inherit",
    env: { ...process.env, BANTOU_SUPERVISOR_PID: String(process.pid), BANTOU_HANDOFF_TOKEN: "" },
  });
  patchNext({ child: child.pid });
  const t = setInterval(() => {
    if (existsSync(join(ws, "server.ready"))) {
      clearInterval(t);
      process.kill(process.pid, "SIGKILL");
    }
  }, 20);
} else {
  const code = await runSupervisor({
    configPath,
    selfBin: "unused",
    version: `next-${spec}`,
    command: () => ({ cmd: process.execPath, args: [serve, "next"] }),
    readyTimeoutMs: Number(process.env.FAKE_NEXT_READY_MS ?? 5000),
    log: () => {},
    handoffToken: token,
    handoff: false,
  });
  process.exit(code);
}
