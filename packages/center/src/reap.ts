import { execFile } from "node:child_process";
import type { Logger } from "./log.js";

export interface ProcInfo {
  pid: number;
  ppid: number;
  pgid: number;
  command: string;
}

const PS_LINE = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/;

/** `ps -A -ww -o pid=,ppid=,pgid=,command=` の出力を分解する。 */
export function parsePs(out: string): ProcInfo[] {
  const procs: ProcInfo[] = [];
  for (const line of out.split("\n")) {
    const m = PS_LINE.exec(line);
    if (!m) continue;
    procs.push({ pid: Number(m[1]), ppid: Number(m[2]), pgid: Number(m[3]), command: m[4] ?? "" });
  }
  return procs;
}

/** 走っているプロセスの一覧。取れなければ null（呼び側は何もしない）。 */
export function listProcesses(): Promise<ProcInfo[] | null> {
  return new Promise((resolve) => {
    execFile("ps", ["-A", "-ww", "-o", "pid=,ppid=,pgid=,command="], { maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
      resolve(err ? null : parsePs(stdout));
    });
  });
}

/**
 * argv が `remote-control ... --name <project>` の形か。token 完全一致のみ（foo と foobar を区別する）。
 * 他のフラグ（--continue 等）は見ない。広い pkill -f 相当の照合はしない。
 */
export function matchesRc(command: string, project: string): boolean {
  const tokens = command.split(/\s+/).filter((t) => t !== "");
  if (!tokens.includes("remote-control")) return false;
  for (let i = 0; i < tokens.length - 1; i++) {
    if (tokens[i] === "--name" && tokens[i + 1] === project) return true;
  }
  return false;
}

export interface MatchOptions {
  /** 孤児とみなす条件。既定は ppid === 1（init / launchd に付け替わった）。 */
  isOrphan?: (proc: ProcInfo) => boolean;
  selfPid?: number;
  /** 自分の子の pid（除外する）。 */
  ownPids?: ReadonlySet<number>;
}

const defaultIsOrphan = (p: ProcInfo): boolean => p.ppid === 1;

/** 同じ project の remote-control の孤児か（純関数）。 */
export function matchOrphan(proc: ProcInfo, project: string, opts: MatchOptions = {}): boolean {
  if (proc.pid === (opts.selfPid ?? process.pid)) return false;
  if (opts.ownPids?.has(proc.pid)) return false;
  if (!(opts.isOrphan ?? defaultIsOrphan)(proc)) return false;
  return matchesRc(proc.command, project);
}

export interface ReapDeps {
  list?: () => Promise<ProcInfo[] | null>;
  /** signal 0 は生存確認。group kill の時は pid に負数を渡す。 */
  kill?: (pid: number, signal: NodeJS.Signals | 0) => void;
  isAlive?: (pid: number) => boolean;
  graceMs?: number;
  pollMs?: number;
  log?: Logger;
  match?: MatchOptions;
}

const defaultKill = (pid: number, signal: NodeJS.Signals | 0): void => {
  process.kill(pid, signal);
};

const defaultIsAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
};

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * 同じ project の remote-control の孤児を止める（SIGTERM → graceMs → SIGKILL）。止めた件数を返す。
 * group kill（-pid）は pgid === pid（新 center が detached で起動した leader）の時だけ。
 * それ以前の版の孤児は desktop の pgid を共有するので pid 単体にだけ送る。
 * ps が取れない時は何もしない。
 */
export async function reapOrphans(project: string, deps: ReapDeps = {}): Promise<number> {
  const list = deps.list ?? listProcesses;
  const kill = deps.kill ?? defaultKill;
  const isAlive = deps.isAlive ?? defaultIsAlive;
  const graceMs = deps.graceMs ?? 3000;
  const pollMs = deps.pollMs ?? 50;
  const log = deps.log ?? (() => {});

  const procs = await list();
  if (!procs) {
    log(`孤児回収: ps を取得できないため行わない project=${project}`);
    return 0;
  }
  const targets = procs.filter((p) => matchOrphan(p, project, deps.match));
  if (targets.length === 0) return 0;

  const send = (t: ProcInfo, sig: NodeJS.Signals): void => {
    const target = t.pgid === t.pid ? -t.pid : t.pid;
    try {
      kill(target, sig);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ESRCH") return;
      if (target < 0) {
        // group に送れなければ pid 単体へ
        try {
          kill(t.pid, sig);
        } catch {
          /* 終了済み */
        }
        return;
      }
      log(`孤児回収: signal 送信失敗 pid=${t.pid} ${(err as Error).message}`);
    }
  };

  for (const t of targets) {
    log(`孤児回収: SIGTERM project=${project} pid=${t.pid} ppid=${t.ppid} pgid=${t.pgid} cmd=${t.command}`);
    send(t, "SIGTERM");
  }
  const deadline = Date.now() + graceMs;
  let alive = targets.filter((t) => isAlive(t.pid));
  while (alive.length > 0 && Date.now() < deadline) {
    await sleep(pollMs);
    alive = alive.filter((t) => isAlive(t.pid));
  }
  for (const t of alive) {
    // pid 再利用対策: SIGKILL 直前に argv を再照合する
    const now = (await list())?.find((p) => p.pid === t.pid);
    if (!now || !matchOrphan(now, project, deps.match)) continue;
    log(`孤児回収: SIGKILL project=${project} pid=${t.pid} (${graceMs}ms 以内に終了せず)`);
    send(now, "SIGKILL");
  }
  log(`孤児回収: ${targets.length} 件を止めた project=${project}`);
  return targets.length;
}
