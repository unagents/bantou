// supervisor test 用の偽の子（--serve）。FAKE_WS / FAKE_PLAN（起動ごとの振る舞いの JSON 配列）で動く。
// 振る舞い: "serve"（ready を書いて待つ）/ "update:<spec>"（ready 後に restart を書いて終了）/ "crash"（ready 前に exit 3）/ "hang"（ready せず居座る）
import { appendFileSync, existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assertServeAllowed, isAlive } from "../../bin/supervisor.mjs";

const ws = process.env.FAKE_WS;
const plan = JSON.parse(process.env.FAKE_PLAN ?? "[]");
const startsLog = join(ws, "starts.log");
const n = existsSync(startsLog) ? readFileSync(startsLog, "utf8").split("\n").filter(Boolean).length : 0;
const mode = plan[Math.min(n, plan.length - 1)] ?? "serve";
const readyPath = join(ws, "server.ready");
const readyAtStart = existsSync(readyPath);
// 本物の子（bin/bantou.mjs --serve）と同じ起動条件。通らなければ記録して exit 1
try {
  assertServeAllowed(ws, process.env);
} catch {
  appendFileSync(startsLog, JSON.stringify({ n, mode: "rejected", pid: process.pid }) + "\n");
  process.exit(1);
}
const lock = JSON.parse(readFileSync(join(ws, "server.lock"), "utf8"));
const sup = Number(process.env.BANTOU_SUPERVISOR_PID);
const earlier = existsSync(startsLog) ? readFileSync(startsLog, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l).pid) : [];
appendFileSync(
  startsLog,
  JSON.stringify({
    n,
    mode,
    pid: process.pid,
    readyAtStart,
    lockMatches: lock.pid === sup || lock.next?.pid === sup,
    // 起動時に生きている別の子（同時に 2 本走らない確認用）
    aliveOthers: earlier.filter((p) => p !== process.pid && isAlive(p)).length,
  }) + "\n",
);

const ready = () => writeFileSync(readyPath, JSON.stringify({ pid: process.pid, version: "fake" }));
const cleanup = () => {
  try {
    unlinkSync(readyPath);
  } catch {}
};
process.on("SIGTERM", () => {
  cleanup();
  process.exit(0);
});

if (mode === "crash") process.exit(3);
else if (mode === "hang") setInterval(() => {}, 1000);
else if (mode.startsWith("update:")) {
  ready();
  setTimeout(() => {
    const spec = mode.slice("update:".length);
    writeFileSync(join(ws, "update.json"), JSON.stringify({ state: "restart", to: `v-${spec}`, spec }));
    cleanup();
    process.exit(0);
  }, 200);
} else if (mode.startsWith("exit:")) {
  ready();
  setTimeout(() => {
    cleanup();
    process.exit(Number(mode.slice(5)));
  }, 150);
} else {
  ready();
  setInterval(() => {}, 1000);
}
