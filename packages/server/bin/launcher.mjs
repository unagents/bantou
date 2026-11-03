// bantou-server の launcher。`npx bantou` で起動した process がそのまま残り、supervisor を起動して見張るだけの凍結物。
// 凍結: node 組み込みのみを使い、起動時に全コードを読み込む。以後は package dir を読まない（npx の取得物が入れ替わっても影響しない）。
// 後続の版と交わす取り決め（今後も変えない）:
//   - config の workspace
//   - <workspace>/server.lock の pid / launcher
//   - <workspace>/server.exit の {launcher, code}
//   - SIGTERM / SIGINT の中継
//   - env BANTOU_LAUNCHER_PID（launcher の pid。supervisor が lock.launcher と server.exit.launcher に書く）
// 動き: 起動時に 1 回だけ同 package の `--supervise` を起動する。supervisor は更新のたびに新版の supervisor へ引き継いで入れ替わる（pid が変わる）。
// launcher は lock.launcher が自分で、lock.pid が生きている間見張り、系列が消えたら終了コードを決めて終わる。
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}

function workspaceOf(configPath) {
  const data = readJson(configPath);
  const ws = data && typeof data === "object" ? data.workspace : undefined;
  if (typeof ws !== "string" || ws.length === 0 || !isAbsolute(ws)) throw new Error(`config の workspace は絶対パスの文字列が必須: ${configPath}`);
  return ws;
}

/**
 * launcher 本体。終了コードを返す。
 * opts: configPath / selfBin（supervisor を持つ bin。`--supervise` で起動する） / pollMs? / pid? / env? / log?
 */
export async function runLauncher(opts) {
  const { configPath, selfBin } = opts;
  const log = opts.log ?? ((m) => console.log(`${new Date().toISOString()} bantou: launcher: ${m}`));
  const pollMs = opts.pollMs ?? 500;
  const me = opts.pid ?? process.pid;
  const env = opts.env ?? process.env;
  const ws = workspaceOf(configPath);
  const lockPath = join(ws, "server.lock");
  const exitPath = join(ws, "server.exit");

  let stopping = false;
  let lastSig = "SIGTERM";
  let childDone = false;
  const signaled = new Set();
  const relay = (pid, sig) => {
    if (signaled.has(pid)) return;
    signaled.add(pid);
    try {
      process.kill(pid, sig);
    } catch {
      // 既に消えている
    }
  };
  const ownLock = () => {
    const lock = readJson(lockPath);
    return lock && lock.launcher === me ? lock : undefined;
  };

  const child = spawn(process.execPath, [selfBin, "--supervise", "--config", configPath], {
    stdio: "inherit",
    env: { ...env, BANTOU_LAUNCHER_PID: String(me) },
  });
  const childExited = new Promise((res) => {
    child.once("error", (e) => {
      log(`supervisor を起動できない: ${e.message}`);
      res({ code: 127, signal: null });
    });
    child.once("exit", (code, signal) => res({ code, signal }));
  }).then((r) => {
    childDone = true;
    return r;
  });

  const onSignal = (sig) => {
    if (!stopping) log(`${sig} 受信、supervisor へ中継`);
    stopping = true;
    lastSig = sig;
    if (!childDone) relay(child.pid, sig);
    const lock = ownLock();
    if (lock && alive(lock.pid)) relay(lock.pid, sig);
  };
  const onTerm = () => onSignal("SIGTERM");
  const onInt = () => onSignal("SIGINT");
  process.on("SIGTERM", onTerm);
  process.on("SIGINT", onInt);

  try {
    const ex = await childExited;
    let sawOther = false;
    for (;;) {
      const lock = ownLock();
      if (!lock || !(alive(lock.pid) || alive(lock.next?.pid))) break;
      if (lock.pid !== child.pid) sawOther = true;
      if (stopping && alive(lock.pid)) relay(lock.pid, lastSig);
      await sleep(pollMs);
    }
    const fin = readJson(exitPath);
    let code;
    if (fin && fin.launcher === me && Number.isInteger(fin.code)) code = fin.code;
    else if (sawOther) code = 1;
    else code = ex.code ?? (stopping ? 0 : 1);
    log(`終了 code=${code}`);
    return code;
  } finally {
    process.off("SIGTERM", onTerm);
    process.off("SIGINT", onInt);
  }
}
