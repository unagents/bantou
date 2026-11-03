// bantou-server の supervisor。`--supervise` で起動し、子（常駐本体、--serve）を 1 つだけ持つ。Nitro は読まない。
// 自己更新では (1) 子が全部終わるのを待って update.json に restart を書き exit 0、(2) supervisor が新版の supervisor へ引き継ぐ
// （`bantou --handoff-protocol` が "1" を返す版のみ。返さない版は従来どおり子だけ入れ替える）。
// 引き継ぎ: 旧 supervisor（S2）が lock に next:{token} を付けて新版の `--supervise` を起動 → 新 supervisor（S3）が試行モードで
// 子を起動し ready を待つ → S2 が lock を S3 に書き換えて exit 0。S3 が駄目なら S2 が巻き戻す（直前の版の子で起動し直す）。
// 取り決め（<workspace> の server.lock / server.ready / server.exit / update.json、env BANTOU_SUPERVISOR_PID / BANTOU_LAUNCHER_PID /
// BANTOU_HANDOFF_TOKEN、`--serve` / `--supervise` / `--handoff-protocol`）は、版をまたぐので変えるなら後方互換を保つ。
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";

export const LOCK_FILE = "server.lock";
export const READY_FILE = "server.ready";
export const UPDATE_FILE = "update.json";
export const EXIT_FILE = "server.exit";
/** 更新後の子が ready になるまでの猶予。超えたら直前の版へ巻き戻す。 */
export const READY_TIMEOUT_MS = 120_000;
/** 引き継ぎ先の取得・起動にかかる分の上乗せ（S2 が S3 を待つ上限 = READY_TIMEOUT_MS + これ）。 */
export const HANDOFF_SLACK_MS = 60_000;
/** `--handoff-protocol` の確認の打ち切り。 */
const PROBE_TIMEOUT_MS = 120_000;
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

/** 一時ファイルに書いて rename する（読む側が書きかけを見ない）。 */
function writeAtomic(path, text) {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, path);
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

/** `<workspace>/server.lock` の中身。無ければ undefined。 */
export function readLock(workspace) {
  return readJson(join(workspace, LOCK_FILE));
}

/** server.lock を atomic に書き換える（rename）。 */
export function writeLock(workspace, lock) {
  writeAtomic(join(workspace, LOCK_FILE), JSON.stringify(lock) + "\n");
}

/**
 * `<workspace>/server.lock` を排他作成する（O_EXCL）。既にあって pid が生きていれば（引き継ぎ中の next.pid が生きていても）投げる。
 * 死んでいれば取り直す。launcher を渡すと lock に記録する。
 * 戻り値は解放関数。lock.pid が自分の時だけ消す（引き継ぎで持ち主が替わった後や、試行側は何もしない）。
 */
export function acquireLock(workspace, version, pid = process.pid, launcher = undefined) {
  mkdirSync(workspace, { recursive: true });
  const path = join(workspace, LOCK_FILE);
  const body =
    JSON.stringify({ pid, version, started_at: new Date().toISOString(), ...(launcher !== undefined ? { launcher } : {}) }) + "\n";
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
      if (cur && Number.isInteger(cur.pid) && cur.pid !== pid) {
        if (isAlive(cur.pid)) throw new Error(`既に起動中 pid=${cur.pid} (${path})`);
        if (cur.next && isAlive(cur.next.pid)) throw new Error(`引き継ぎ中 pid=${cur.next.pid} (${path})`);
      }
      tryUnlink(path);
    }
  }
  throw new Error(`lock を取れない: ${path}`);
}

/** 子（--serve）の起動条件。BANTOU_SUPERVISOR_PID が lock の pid（または引き継ぎ試行中の next.pid）と合わなければ投げる。 */
export function assertServeAllowed(workspace, env = process.env) {
  const lock = readLock(workspace);
  const sup = Number(env.BANTOU_SUPERVISOR_PID);
  const ok =
    lock &&
    Number.isInteger(sup) &&
    ((lock.pid === sup && isAlive(sup)) || (lock.next && lock.next.pid === sup && isAlive(sup)));
  if (!ok) {
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

/** 引き継ぎ先 supervisor の起動コマンド。 */
export function defaultNextCommand(configPath) {
  return (spec) => ({ cmd: "npx", args: ["-y", `--package=${spec}`, "--", "bantou", "--supervise", "--config", configPath] });
}

/** 引き継ぎに対応した版か確かめる。`npx -y --package=<spec> -- bantou --handoff-protocol` が "1" を出して exit 0 なら対応。 */
export function defaultProbe(spec, env = process.env) {
  return new Promise((resolve) => {
    let out = "";
    let settled = false;
    const done = (v) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(v);
    };
    let p;
    try {
      p = spawn("npx", ["-y", `--package=${spec}`, "--", "bantou", "--handoff-protocol"], { env, stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      resolve(false);
      return;
    }
    const timer = setTimeout(() => {
      p.kill("SIGKILL");
      done(false);
    }, PROBE_TIMEOUT_MS);
    p.stdout.setEncoding("utf8");
    p.stdout.on("data", (c) => (out += c));
    p.once("error", () => done(false));
    p.once("exit", (code) => done(code === 0 && out.trim() === "1"));
  });
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

function signalPid(pid, sig) {
  try {
    process.kill(-pid, sig);
  } catch {
    try {
      process.kill(pid, sig);
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

/** pid（とその group）を SIGTERM、消えなければ SIGKILL で消す。 */
async function killPid(pid, ms = 5000) {
  if (!isAlive(pid)) return;
  signalPid(pid, "SIGTERM");
  if (await waitPidGone(pid, ms)) return;
  signalPid(pid, "SIGKILL");
  await waitPidGone(pid, ms);
}

/**
 * supervisor 本体。終了コード（子の exit code）を返す。
 * opts: configPath / selfBin / version / command?(spec)=>{cmd,args} / readyTimeoutMs? / log? / pid? / env? /
 *   launcher?(launcher の pid。既定は env BANTOU_LAUNCHER_PID) / handoffToken?(試行モード。既定は env BANTOU_HANDOFF_TOKEN) /
 *   handoff?(false で引き継ぎを使わない) / probe?(spec)=>Promise<boolean> / nextCommand?(spec)=>{cmd,args} / handoffSlackMs?
 */
export async function runSupervisor(opts) {
  const { configPath, version } = opts;
  const env0 = opts.env ?? process.env;
  const log = opts.log ?? ((m) => console.log(`${new Date().toISOString()} bantou: supervisor: ${m}`));
  const readyTimeoutMs = opts.readyTimeoutMs ?? READY_TIMEOUT_MS;
  const handoffSlackMs = opts.handoffSlackMs ?? HANDOFF_SLACK_MS;
  const command = opts.command ?? defaultCommand(opts.selfBin, configPath);
  const pid = opts.pid ?? process.pid;
  const launcherEnv = Number(env0.BANTOU_LAUNCHER_PID);
  const launcher = opts.launcher ?? (Number.isInteger(launcherEnv) && launcherEnv > 0 ? launcherEnv : undefined);
  const token = opts.handoffToken ?? (env0.BANTOU_HANDOFF_TOKEN || undefined);
  const trial = typeof token === "string" && token !== "";
  const workspace = readWorkspace(configPath);
  const lockPath = join(workspace, LOCK_FILE);
  const readyPath = join(workspace, READY_FILE);
  const updatePath = join(workspace, UPDATE_FILE);
  const exitPath = join(workspace, EXIT_FILE);

  if (trial) {
    const lock = readLock(workspace);
    if (!lock || !lock.next || lock.next.token !== token || !isAlive(lock.pid)) {
      throw new Error("引き継ぎできない（server.lock の next.token が合わない、または旧 supervisor がいない）");
    }
  } else {
    acquireLock(workspace, version, pid, launcher);
    tryUnlink(exitPath);
  }

  let stopping = false;
  let current;
  /** 引き継ぎ先として起動中の process（S2 側）。 */
  let nextProc;
  let nextDone = true;
  const onSignal = (sig) => {
    if (stopping) return;
    stopping = true;
    log(`${sig} 受信、子へ中継`);
    if (current) signalGroup(current, "SIGTERM");
    if (nextProc && !nextDone) signalGroup(nextProc, "SIGTERM");
  };
  const onTerm = () => onSignal("SIGTERM");
  const onInt = () => onSignal("SIGINT");
  process.on("SIGTERM", onTerm);
  process.on("SIGINT", onInt);

  /** lock の持ち主が自分の時だけ、child を記録する（観測用）。 */
  const noteChild = (c) => {
    const cur = readLock(workspace);
    if (cur && cur.pid === pid && !cur.next) writeLock(workspace, { ...cur, child: c.pid });
  };

  /** 子を起動する。ready か exit の先に来た方で解決する。 */
  const start = (spec) => {
    const { cmd, args } = command(spec);
    log(`子を起動: ${spec === null ? "(自分の .output)" : spec}`);
    const childEnv = { ...env0, BANTOU_SUPERVISOR_PID: String(pid) };
    delete childEnv.BANTOU_HANDOFF_TOKEN;
    const child = spawn(cmd, args, { detached: true, stdio: "inherit", env: childEnv });
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

  /** run の子を止める（SIGTERM、5 秒で SIGKILL）。 */
  const stopRun = async (run) => {
    signalGroup(run.child, "SIGTERM");
    const exitedInTime = await Promise.race([run.exited.then(() => true), sleep(5000).then(() => false)]);
    if (!exitedInTime) signalGroup(run.child, "SIGKILL");
    await run.exited;
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

  /**
   * 試行モード（S3）。lock の next に自分を書き、子を起動して ready を待ち、S2 が lock を渡すのを待つ。
   * 成功で adopt する run、失敗で null（lock は触らない）。
   */
  const trialPhase = async () => {
    /** next.token が自分のものなら patch する。取り消されていれば false。 */
    const patchNext = (patch) => {
      const cur = readLock(workspace);
      if (!cur || !cur.next || cur.next.token !== token) return false;
      writeLock(workspace, { ...cur, next: { ...cur.next, ...patch } });
      return true;
    };
    if (!patchNext({ pid, version })) {
      log("引き継ぎが取り消されていた");
      return null;
    }
    const run = start(null);
    if (!patchNext({ child: run.child.pid })) {
      log("引き継ぎが取り消された、子を止める");
      await stopRun(run);
      return null;
    }
    let exited = false;
    run.exited.then(() => {
      exited = true;
    });
    const end = Date.now() + readyTimeoutMs;
    let ready = false;
    for (;;) {
      if (stopping) {
        await stopRun(run);
        return null;
      }
      if (exited) {
        log("試行の子が ready 前に終了、引き継ぎを諦める");
        return null;
      }
      const lock = readLock(workspace);
      if (lock && lock.pid === pid) {
        log("lock を受け取った、通常モードへ");
        return run;
      }
      if (!lock || !lock.next || lock.next.token !== token) {
        log("引き継ぎが取り消された、子を止める");
        await stopRun(run);
        return null;
      }
      if (!ready) {
        const r = readJson(readyPath);
        if (r && isAlive(r.pid)) {
          ready = true;
          log("試行の子が ready");
          patchNext({ ready: true });
        } else if (Date.now() > end) {
          log(`試行の子が ${readyTimeoutMs}ms 以内に ready にならない、引き継ぎを諦める`);
          await stopRun(run);
          return null;
        }
      } else if (!isAlive(lock.pid)) {
        // 旧 supervisor が昇格前に死んだ。ready 済みなので自分で昇格する
        log("旧 supervisor が消えた、自分で昇格する");
        tryUnlink(updatePath);
        writeLock(workspace, {
          pid,
          version,
          started_at: new Date().toISOString(),
          ...(launcher !== undefined ? { launcher } : {}),
          child: run.child.pid,
        });
        return run;
      }
      await sleep(50);
    }
  };

  /**
   * 引き継ぎ（S2 側）。戻り値: "promoted"（新 supervisor に渡した）/ "failed"（巻き戻しが要る。update.json に failed 記録済み）/
   * "stopped"（試行中に停止要求）/ "unsupported"（引き継げない版。子だけ入れ替える）。
   */
  const handoff = async (spec, to) => {
    const probe = opts.probe ?? ((s) => defaultProbe(s, env0));
    if (!(await probe(spec))) {
      log(`引き継ぎ非対応の版、子だけ入れ替える: ${spec}`);
      return "unsupported";
    }
    if (stopping) return "stopped";
    const lock0 = readLock(workspace);
    if (!lock0 || lock0.pid !== pid) {
      log("server.lock が自分のものでない、引き継がず子だけ入れ替える");
      return "unsupported";
    }
    const myToken = randomUUID();
    writeLock(workspace, { ...lock0, next: { token: myToken } });
    const nc = (opts.nextCommand ?? defaultNextCommand(configPath))(spec);
    const nextEnv = { ...env0, BANTOU_HANDOFF_TOKEN: myToken };
    delete nextEnv.BANTOU_SUPERVISOR_PID;
    if (launcher !== undefined) nextEnv.BANTOU_LAUNCHER_PID = String(launcher);
    log(`次期 supervisor を起動: ${spec}`);
    const proc = spawn(nc.cmd, nc.args, { detached: true, stdio: "inherit", env: nextEnv });
    nextProc = proc;
    nextDone = false;
    const procExited = new Promise((res) => {
      proc.once("error", (e) => {
        log(`次期 supervisor を起動できない: ${e.message}`);
        res();
      });
      proc.once("exit", () => res());
    }).then(() => {
      nextDone = true;
    });

    const end = Date.now() + readyTimeoutMs + handoffSlackMs;
    let verdict;
    let reason = "";
    let promotedLock;
    for (;;) {
      const l = readLock(workspace);
      if (stopping) {
        verdict = "stopped";
        break;
      }
      if (l && l.pid === pid && l.next && l.next.token === myToken && l.next.ready === true && isAlive(l.next.pid)) {
        verdict = "promoted";
        promotedLock = l;
        break;
      }
      if (nextDone) {
        verdict = "failed";
        reason = "次期 supervisor が ready 前に終了";
        break;
      }
      if (Date.now() > end) {
        verdict = "failed";
        reason = `${readyTimeoutMs + handoffSlackMs}ms 以内に ready にならない`;
        break;
      }
      await sleep(50);
    }

    if (verdict === "promoted") {
      tryUnlink(updatePath);
      writeLock(workspace, {
        pid: promotedLock.next.pid,
        version: promotedLock.next.version ?? "",
        started_at: new Date().toISOString(),
        ...(launcher !== undefined ? { launcher } : {}),
        ...(promotedLock.next.child !== undefined ? { child: promotedLock.next.child } : {}),
      });
      proc.unref();
      log(`次期 supervisor に引き継いだ: pid=${promotedLock.next.pid} version=${promotedLock.next.version}`);
      return "promoted";
    }

    // 巻き戻し / 停止: 次期 supervisor の系列を全部消してから lock を自分に戻す
    log(verdict === "stopped" ? "引き継ぎ中に停止要求、次期 supervisor を片付ける" : `引き継ぎに失敗、巻き戻す: ${reason}`);
    if (!nextDone) {
      signalGroup(proc, "SIGTERM");
      const inTime = await Promise.race([procExited.then(() => true), sleep(5000).then(() => false)]);
      if (!inTime) {
        signalGroup(proc, "SIGKILL");
        await Promise.race([procExited, sleep(5000)]);
      }
    }
    const nx = readLock(workspace)?.next;
    const ready = readJson(readyPath);
    for (const p of [nx?.child, nx?.pid, ready?.pid]) {
      if (Number.isInteger(p) && p !== pid) await killPid(p);
    }
    await clearOld();
    const base = { ...(readLock(workspace) ?? lock0) };
    delete base.next;
    writeLock(workspace, { ...base, pid, ...(lock0.child !== undefined ? { child: lock0.child } : {}) });
    if (verdict === "failed") {
      writeAtomic(
        updatePath,
        JSON.stringify({ state: "failed", to: to ?? spec, error: `起動できない: 引き継ぎに失敗（${reason}）`, at: new Date().toISOString() }) + "\n",
      );
    }
    return verdict;
  };

  let lastGood = null;
  let candidate = null;
  /** candidate の版（update.json の to）。failed の記録に使う（center が版で照合する）。 */
  let candidateTo = null;
  let rollback = false;
  let result = 1;
  let adopted = null;
  try {
    let go = true;
    if (trial) {
      adopted = await trialPhase();
      if (!adopted) {
        go = false;
        result = stopping ? 0 : 1;
      }
    } else {
      tryUnlink(readyPath);
    }
    while (go) {
      if (stopping) {
        result = 0;
        break;
      }
      const trying = candidate;
      const tryingTo = candidateTo;
      candidate = null;
      candidateTo = null;
      // 更新で起動した子だけ ready を待つ。最初の子と巻き戻し先は待たずにそのまま走らせる（引き継ぎで受けた子は試行中に待ち済み）
      const watched = adopted === null && trying !== null && !rollback;
      rollback = false;
      const run = adopted ?? start(trying);
      if (adopted === null) noteChild(run.child);
      adopted = null;
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
          writeAtomic(
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
        const to = typeof upd.to === "string" ? upd.to : null;
        if (opts.handoff !== false) {
          const h = await handoff(upd.spec, to);
          if (h === "promoted") {
            result = 0;
            break;
          }
          if (h === "stopped") {
            await clearOld();
            result = 0;
            break;
          }
          if (h === "failed") {
            candidate = lastGood;
            rollback = true;
            continue;
          }
        }
        candidate = upd.spec;
        candidateTo = to;
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
    // lock の持ち主が自分の時だけ終了を記録して lock を消す（引き継ぎで渡した後・試行側は何もしない）。
    // server.exit を先に書く（launcher は lock が消えたら server.exit を読む）
    const cur = readLock(workspace);
    if (cur && cur.pid === pid) {
      if (launcher !== undefined) writeAtomic(exitPath, JSON.stringify({ launcher, code: result }) + "\n");
      tryUnlink(lockPath);
    }
  }
  log(`終了 code=${result}`);
  return result;
}
