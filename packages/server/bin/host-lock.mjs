// bantou-server の host 単位の多重起動 guard。node 組み込みのみ。launcher（bin/bantou.mjs の既定モード）が起動時に 1 回取る。
// <workspace>/server.lock（workspace 単位。supervisor 交代・引き継ぎ用）とは別物で、user・workspace をまたいで「1 host に 1 つ」を保つ。
//   - 場所: 固定の /tmp/bantou-server.lock（user をまたぐため。os.tmpdir() は TMPDIR / macOS で user ごとに変わるので使わない。/tmp が無ければ os.tmpdir()）。
//     test 用に env BANTOU_SERVER_HOST_LOCK で差し替える。
//   - 取得: 全内容を書いた一時ファイルを link() で置く（atomic。書きかけを他者が見ない）。mode 0666（他 user が読め、stale 時に書き換えられる）。
//   - 生存確認: pid が生きていて、かつ起動時刻 token（Linux: /proc/<pid>/stat の starttime、他: ps lstart）が lock と一致すること。
//     pid 再利用で別 process が同じ pid になっても token が違えば stale。token を読めない時は pid の生存だけで判定する。
//   - stale / 解放: sticky な /tmp では他 user の lock を unlink できないので、stale の取り直しは内容の上書き（空白埋めで縮めない）で行い、
//     書いた後に読み直して自分の pid か確かめる。正常終了時は自分の lock を消す（消せなければ released に上書き）。SIGKILL・OOM 等は stale 判定で回収。
//   - 競合・信頼できない lock は exit 75（EX_TEMPFAIL。systemd unit の RestartPreventExitStatus=75 で再起動ループを止める）。
//   - 外し方: env BANTOU_SERVER_ALLOW_MULTI=1（取得も解放もしない）。
import { chmodSync, closeSync, constants, existsSync, fstatSync, fsyncSync, linkSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";

export const LOCK_NAME = "bantou-server.lock";
/** 競合・信頼できない lock で終了する時の exit code（EX_TEMPFAIL）。systemd unit の RestartPreventExitStatus と揃える。 */
export const EXIT_CONFLICT = 75;

/** lock を安全に扱えない（symlink・通常 file でない・hardlink・読めない・書けない）。message をそのまま出して終了する。 */
export class HostLockError extends Error {
  constructor(path, reason, detail = "") {
    super(unsafeMessage(path, reason, detail));
    this.name = "HostLockError";
  }
}

function unsafeMessage(path, reason, detail) {
  return [
    `bantou-server を起動しない: host lock が信頼できない/扱えない: ${reason}${detail ? ` (${detail})` : ""}`,
    `lock: ${path}（他 user が置いた file の可能性。持ち主を確かめる）`,
    `消す手順: root が \`rm ${path}\`（sticky な /tmp では置いた本人か root のみ消せる）`,
    `一時的に外す: env BANTOU_SERVER_ALLOW_MULTI=1（test・開発のみ）`,
  ].join("\n");
}

const O_NOFOLLOW = constants.O_NOFOLLOW ?? 0;

/**
 * lock を symlink を辿らずに開き、通常 file・nlink=1 を確かめる。不正なら HostLockError。
 * 自分の link() 直後は一時ファイルの分で nlink=2 の瞬間があるので、少し待って数回見直す。
 */
function openSafe(path, flags) {
  let fd;
  try {
    fd = openSync(path, flags | O_NOFOLLOW);
  } catch (e) {
    if (e.code === "ELOOP" || e.code === "EMLINK") throw new HostLockError(path, "symlink", e.code);
    if (e.code === "EACCES" || e.code === "EPERM") throw new HostLockError(path, "読めない/書けない file", e.code);
    throw e;
  }
  try {
    for (let i = 0; ; i++) {
      const st = fstatSync(fd);
      if (!st.isFile()) throw new HostLockError(path, "通常 file でない");
      if (st.nlink === 1) return { fd, st };
      if (i >= 5) throw new HostLockError(path, "hardlink（nlink>1）", `nlink=${st.nlink} owner uid=${st.uid}`);
      const until = Date.now() + 20;
      while (Date.now() < until);
    }
  } catch (e) {
    closeSync(fd);
    throw e;
  }
}

/** lock の場所。 */
export function hostLockPath(env = process.env) {
  if (env.BANTOU_SERVER_HOST_LOCK) return env.BANTOU_SERVER_HOST_LOCK;
  return join(existsSync("/tmp") ? "/tmp" : tmpdir(), LOCK_NAME);
}

export function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}

/** pid の起動時刻 token。読めなければ null。 */
export function startToken(pid) {
  try {
    if (process.platform === "linux") {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      // comm は括弧内で空白・括弧を含みうるので最後の ')' の後ろを分割する。starttime は全体の 22 番目 = 括弧の後の 20 番目（0 始まり 19）
      const rest = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      return rest[19] ? `proc:${rest[19]}` : null;
    }
    const out = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], env: { ...process.env, LC_ALL: "C" } }).trim();
    return out ? `ps:${out}` : null;
  } catch {
    return null;
  }
}

function currentUser() {
  try {
    return userInfo().username;
  } catch {
    return String(process.getuid?.() ?? "unknown");
  }
}

/** lock を読む。無い・壊れている（JSON でない）は undefined、symlink 等・読めないは HostLockError。owner uid を __uid に足す。 */
function readLock(path) {
  let o;
  try {
    o = openSafe(path, constants.O_RDONLY);
  } catch (e) {
    if (e.code === "ENOENT") return undefined;
    throw e;
  }
  try {
    const v = JSON.parse(readFileSync(o.fd, "utf8"));
    return v && typeof v === "object" ? { ...v, __uid: o.st.uid } : undefined;
  } catch {
    return undefined;
  } finally {
    closeSync(o.fd);
  }
}

/** lock の持ち主が今も生きているか。lock が無い・解放済み・壊れている時は false。 */
export function holderAlive(lock) {
  if (!lock || !Number.isInteger(lock.pid) || lock.released) return false;
  if (!isAlive(lock.pid)) return false;
  if (typeof lock.start !== "string") return true;
  const now = startToken(lock.pid);
  return now === null || now === lock.start;
}

function bodyOf(info) {
  return JSON.stringify({
    pid: process.pid,
    user: currentUser(),
    started_at: new Date().toISOString(),
    start: startToken(process.pid),
    ...info,
  });
}

/** 既存 file の内容を縮めずに上書きする（読み手が空の file を見ない）。 */
function overwriteInPlace(path, text) {
  const { fd, st } = openSafe(path, constants.O_RDWR);
  try {
    writeSync(fd, Buffer.from(text.padEnd(st.size, " ") + "\n"), 0);
    fsyncSync(fd);
  } catch (e) {
    if (e.code === "EACCES" || e.code === "EPERM") throw new HostLockError(path, "書けない file", e.code);
    throw e;
  } finally {
    closeSync(fd);
  }
}

/**
 * host lock を取る。戻り値: { ok: true, release } | { ok: false, holder, path }。
 * env BANTOU_SERVER_ALLOW_MULTI=1 なら何もせず ok（release は no-op）。
 * info: lock に足す情報（workspace / version など）。
 */
export function acquireHostLock({ env = process.env, info = {} } = {}) {
  const noop = () => {};
  if (env.BANTOU_SERVER_ALLOW_MULTI === "1") return { ok: true, release: noop, path: null };
  const path = hostLockPath(env);
  const body = bodyOf(info);
  const mine = (lock) => lock && lock.pid === process.pid && lock.start === (startToken(process.pid) ?? lock.start);
  const release = () => {
    let cur;
    try {
      cur = readLock(path);
    } catch {
      return;
    }
    if (!cur || cur.pid !== process.pid) return;
    try {
      unlinkSync(path);
    } catch {
      try {
        overwriteInPlace(path, JSON.stringify({ released: true }));
      } catch {
        // 消せなければ stale 判定に任せる
      }
    }
  };
  for (let attempt = 0; attempt < 3; attempt++) {
    // 新規作成: 全内容入りの一時ファイルを link() で置く（既にあれば EEXIST）
    const tmp = `${path}.${process.pid}.${attempt}.tmp`;
    try {
      const fd = openSync(tmp, "wx", 0o666);
      try {
        writeSync(fd, body + "\n");
      } finally {
        closeSync(fd);
      }
      chmodSync(tmp, 0o666);
      try {
        linkSync(tmp, path);
        return { ok: true, release, path };
      } catch (e) {
        if (e.code !== "EEXIST") throw e;
      }
    } finally {
      try {
        unlinkSync(tmp);
      } catch {
        // 無ければよい
      }
    }
    const cur = readLock(path);
    if (cur && cur.pid === process.pid && holderAlive(cur)) return { ok: true, release, path }; // 自分の lock（再入）
    if (holderAlive(cur)) return { ok: false, holder: cur, path };
    // stale（死んだ・pid 再利用・解放済み・壊れた）: 上書きで取り直し、読み直して自分か確かめる
    try {
      overwriteInPlace(path, body);
    } catch (e) {
      if (e.code === "ENOENT") continue; // 消えた。新規作成からやり直す
      throw e;
    }
    // 同時に取り直した相手と競った場合、最後に書いた方だけが残る。少し置いて読み直す
    const until = Date.now() + 60;
    while (Date.now() < until);
    const after = readLock(path);
    if (mine(after)) return { ok: true, release, path };
    if (holderAlive(after)) return { ok: false, holder: after, path };
  }
  throw new Error(`host lock を取れない: ${path}`);
}

/** 競合時の message。 */
export function conflictMessage(r) {
  const h = r.holder ?? {};
  const untrusted = typeof h.start !== "string" && typeof h.__uid === "number" && h.__uid !== 0 && h.__uid !== process.getuid?.();
  return [
    `bantou-server は既にこの host で起動中: pid=${h.pid} user=${h.user ?? "?"} started_at=${h.started_at ?? "?"}${h.workspace ? ` workspace=${h.workspace}` : ""}`,
    `lock: ${r.path}（1 host に bantou-server は 1 つだけ。2 つ目は起動しない）`,
    `止め方: systemd 配下は \`sudo systemctl stop bantou-server\`、macOS の launchd 配下は \`sudo launchctl bootout system/com.unagents.bantou\`。手起動の場合のみ、起動した user で \`kill -TERM ${h.pid}\`（launcher に SIGTERM）`,
    ...(typeof h.__uid === "number" ? [`lock の owner uid=${h.__uid}${untrusted ? "（token 無し・root でも自分でもない owner: 信頼できない lock の可能性。持ち主を確かめ、不正なら root が \`rm " + r.path + "\`）" : ""}`] : []),
    `pid が実在しない/想定外の lock が残って起動できない時は、root が \`rm ${r.path}\``,
    `意図して複数動かす時（test・開発）は env BANTOU_SERVER_ALLOW_MULTI=1 を付ける`,
  ].join("\n");
}

/**
 * 起動時の guard。取れれば process 終了時の解放を仕掛けて release を返す。競合なら message を stderr に出して exit(1)。
 * opts: env / info / exit（test 差し替え。既定 process.exit）/ err（出力先。既定 console.error）
 */
export function guardHostLock(opts = {}) {
  const exit = opts.exit ?? ((c) => process.exit(c));
  const err = opts.err ?? ((m) => console.error(m));
  const stamp = () => `${new Date().toISOString()} bantou: `;
  let r;
  try {
    r = acquireHostLock({ env: opts.env, info: opts.info });
  } catch (e) {
    // 信頼できない/扱えない lock は stack trace にせず message で止める。それ以外の想定外も message のみ
    err(stamp() + (e instanceof Error ? e.message : String(e)));
    exit(e instanceof HostLockError ? EXIT_CONFLICT : 1);
    return () => {};
  }
  if (!r.ok) {
    err(stamp() + conflictMessage(r));
    exit(EXIT_CONFLICT);
    return () => {};
  }
  process.once("exit", r.release);
  return r.release;
}
