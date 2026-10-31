// 0.3.0（c48cf72）の supervisor そのまま。互換テスト用の fixture（新版の子が旧 supervisor の下でも動くことを確かめる）。変更しない。
// bantou-server の supervisor。`npx bantou` で起動した bin が、子（常駐本体、--serve）を 1 つだけ持つ。
// 自己更新では子だけを入れ替える（supervisor の PID は変わらない）。Nitro は読まない。
// supervisor と子の取り決め（--serve、env BANTOU_SUPERVISOR_PID、<workspace> の server.lock / server.ready / update.json）は
// 今後も変えない。supervisor のコードは最初に起動した版のまま残るため。
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";

export const LOCK_FILE = "server.lock";
export const READY_FILE = "server.ready";
export const UPDATE_FILE = "update.json";
/** 更新後の子が ready になるまでの猶予。超えたら直前の版へ巻き戻す。 */
export const READY_TIMEOUT_MS = 120_000;
/** 旧い子の process が消えるのを待つ上限。 */
const GONE_TIMEOUT_MS = 30_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

function tryUnlink(path) {
  try {
    unlinkSync(path);
  } catch {
    // 無ければよい
  }
}

/** pid が生きているか。 */
export function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}

/** config から workspace だけを読む。不正なら投げる。 */
export function readWorkspace(configPath) {
  let data;
  try {
    data = JSON.parse(readFileSync(configPath, "utf8"));
  } catch (e) {
    throw new Error(`config を読めない: ${configPath} (${e.message})`);
  }
  const ws = data && typeof data === "object" ? data.workspace : undefined;
  if (typeof ws !== "string" || ws.length === 0) throw new Error(`config の workspace は必須の文字列: ${configPath}`);
  if (!isAbsolute(ws)) throw new Error(`config の workspace は絶対パス: ${ws}`);
  return ws;
}

/**
 * `<workspace>/server.lock` を排他作成する（O_EXCL）。既にあって pid が生きていれば投げる。死んでいれば取り直す。
 * 戻り値は解放関数。
 */
export function acquireLock(workspace, version, pid = process.pid) {
  mkdirSync(workspace, { recursive: true });
  const path = join(workspace, LOCK_FILE);
  const body = JSON.stringify({ pid, version, started_at: new Date().toISOString() }) + "\n";
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(path, body, { flag: "wx" });
      return () => {
        const cur = readJson(path);
        if (cur && cur.pid === pid) tryUnlink(path);
      };
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      const cur = readJson(path);
      if (cur && Number.isInteger(cur.pid) && cur.pid !== pid && isAlive(cur.pid)) {
        throw new Error(`既に起動中 pid=${cur.pid} (${path})`);
      }
      tryUnlink(path);
    }
  }
  throw new Error(`lock を取れない: ${path}`);
}

/** 子（--serve）の起動条件。BANTOU_SUPERVISOR_PID が lock の pid と合わなければ投げる。 */
export function assertServeAllowed(workspace, env = process.env) {
  const lock = readJson(join(workspace, LOCK_FILE));
  const sup = Number(env.BANTOU_SUPERVISOR_PID);
  if (!lock || !Number.isInteger(lock.pid) || lock.pid !== sup || !isAlive(lock.pid)) {
    throw new Error("--serve は supervisor 経由でのみ起動できる（BANTOU_SUPERVISOR_PID が server.lock と合わない）");
  }
}

/** 子の起動コマンド。spec が null なら自分の bin（.output）、そうでなければ npx で取得した版。 */
export function defaultCommand(selfBin, configPath) {
  return (spec) =>
    spec === null
      ? { cmd: process.execPath, args: [selfBin, "--serve", "--config", configPath] }
      : { cmd: "npx", args: ["-y", `--package=${spec}`, "--", "bantou", "--serve", "--config", configPath] };
}

function signalGroup(child, sig) {
  try {
    process.kill(-child.pid, sig);
  } catch {
    try {
      child.kill(sig);
    } catch {
      // 既に終わっている
    }
  }
}

async function waitPidGone(pid, ms) {
  const end = Date.now() + ms;
  while (isAlive(pid)) {
    if (Date.now() > end) return false;
    await sleep(50);
  }
  return true;
}

/**
 * supervisor 本体。終了コード（子の exit code）を返す。
 * opts: configPath / selfBin / version / command?(spec)=>{cmd,args} / readyTimeoutMs? / log? / pid? / env?
 */
export async function runSupervisor(opts) {
  const { configPath, version } = opts;
  const log = opts.log ?? ((m) => console.log(`${new Date().toISOString()} bantou: supervisor: ${m}`));
  const readyTimeoutMs = opts.readyTimeoutMs ?? READY_TIMEOUT_MS;
  const command = opts.command ?? defaultCommand(opts.selfBin, configPath);
  const pid = opts.pid ?? process.pid;
  const workspace = readWorkspace(configPath);
  const release = acquireLock(workspace, version, pid);
  const readyPath = join(workspace, READY_FILE);
  const updatePath = join(workspace, UPDATE_FILE);

  let stopping = false;
  let current;
  const onSignal = (sig) => {
    if (stopping) return;
    stopping = true;
    log(`${sig} 受信、子へ中継`);
    if (current) signalGroup(current, "SIGTERM");
  };
  const onTerm = () => onSignal("SIGTERM");
  const onInt = () => onSignal("SIGINT");
  process.on("SIGTERM", onTerm);
  process.on("SIGINT", onInt);

  /** 子を起動する。ready か exit の先に来た方で解決する。 */
  const start = (spec) => {
    const { cmd, args } = command(spec);
    log(`子を起動: ${spec === null ? "(自分の .output)" : spec}`);
    const child = spawn(cmd, args, {
      detached: true,
      stdio: "inherit",
      env: { ...(opts.env ?? process.env), BANTOU_SUPERVISOR_PID: String(pid) },
    });
    current = child;
    const exited = new Promise((res) => {
      child.once("error", (e) => {
        log(`子を起動できない: ${e.message}`);
        res({ code: 127, signal: null });
      });
      child.once("exit", (code, signal) => res({ code, signal }));
    });
    return { child, exited };
  };

  /** ready（server.ready の pid が生きている）か exit か timeout。 */
  const awaitReady = async (run, timeoutMs) => {
    let done = false;
    run.exited.then(() => {
      done = true;
    });
    const end = timeoutMs === undefined ? Infinity : Date.now() + timeoutMs;
    for (;;) {
      if (done) return "exited";
      const r = readJson(readyPath);
      if (r && isAlive(r.pid)) return "ready";
      if (Date.now() > end) return "timeout";
      await sleep(50);
    }
  };

  /** 前の子の process（server.ready の pid）が消えるのを待ち、ready を消す。 */
  const clearOld = async () => {
    const r = readJson(readyPath);
    if (r && isAlive(r.pid)) {
      if (!(await waitPidGone(r.pid, GONE_TIMEOUT_MS))) {
        log(`前の子が残っている、SIGKILL: pid=${r.pid}`);
        try {
          process.kill(r.pid, "SIGKILL");
        } catch {
          // 消えた
        }
        await waitPidGone(r.pid, 5000);
      }
    }
    tryUnlink(readyPath);
  };

  let lastGood = null;
  let candidate = null;
  /** candidate の版（update.json の to）。failed の記録に使う（center が版で照合する）。 */
  let candidateTo = null;
  let rollback = false;
  let result = 0;
  try {
    tryUnlink(readyPath);
    for (;;) {
      if (stopping) break;
      const trying = candidate;
      const tryingTo = candidateTo;
      candidate = null;
      candidateTo = null;
      // 更新で起動した子だけ ready を待つ。最初の子と巻き戻し先は待たずにそのまま走らせる
      const watched = trying !== null && !rollback;
      rollback = false;
      const run = start(trying);
      if (watched) {
        const st = await awaitReady(run, readyTimeoutMs);
        if (st !== "ready") {
          const reason = st === "timeout" ? `${readyTimeoutMs}ms 以内に ready にならない` : "ready 前に終了";
          log(`更新に失敗、巻き戻す: ${trying} (${reason})`);
          if (st === "timeout") signalGroup(run.child, "SIGTERM");
          const exitedInTime = await Promise.race([run.exited.then(() => true), sleep(5000).then(() => false)]);
          if (!exitedInTime) signalGroup(run.child, "SIGKILL");
          await run.exited;
          await clearOld();
          writeFileSync(
            updatePath,
            JSON.stringify({ state: "failed", to: tryingTo ?? trying, error: `起動できない: ${reason}`, at: new Date().toISOString() }) + "\n",
          );
          candidate = lastGood;
          rollback = true;
          continue;
        }
        lastGood = trying;
        tryUnlink(updatePath);
        log(`更新後の子が ready: ${trying}`);
      }
      const ex = await run.exited;
      log(`子が終了 code=${ex.code} signal=${ex.signal}`);
      const upd = readJson(updatePath);
      if (!stopping && upd && upd.state === "restart" && typeof upd.spec === "string") {
        await clearOld();
        candidate = upd.spec;
        candidateTo = typeof upd.to === "string" ? upd.to : null;
        log(`次の版を起動: ${upd.spec}`);
        continue;
      }
      result = ex.code ?? (stopping ? 0 : 1); // stop 要求後に signal で終わった子（npx 経由など）は正常終了扱い
      await clearOld();
      break;
    }
  } finally {
    process.off("SIGTERM", onTerm);
    process.off("SIGINT", onInt);
    release();
  }
  log(`終了 code=${result}`);
  return result;
}
