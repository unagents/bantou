import { spawn as nodeSpawn } from "node:child_process";
import { createWriteStream, type WriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Readable, Writable } from "node:stream";
import type { Config, ProjectConfig } from "./config.js";
import type { Logger } from "./log.js";

export type RcState = "stopped" | "starting" | "connected" | "error";

export interface RcStatus {
  project: string;
  path: string;
  state: RcState;
  pid: number | null;
  sessionUrl: string | null;
  environmentUrl: string | null;
  restarts: number;
  lastExit: { code: number | null; signal: string | null; at: string } | null;
  lastError?: string;
  startedAt: string | null;
  args: string[] | null;
}

/** supervisor が子プロセスに要求する最小の形（テストで偽物に差し替える）。 */
export interface ChildLike {
  pid?: number;
  stdin: Writable | null;
  stdout: Readable | null;
  stderr: Readable | null;
  kill(signal?: NodeJS.Signals | number): boolean;
  on(event: "exit", cb: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  on(event: "error", cb: (err: Error) => void): unknown;
  /** exit 後、stdout / stderr も閉じてから 1 回だけ来る。 */
  on(event: "close", cb: () => void): unknown;
}

export type SpawnImpl = (
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; stdio: ["pipe", "pipe", "pipe"] },
) => ChildLike;

export interface RemoteControlSupervisor {
  start(project: string): Promise<RcStatus>;
  stop(project: string): Promise<RcStatus>;
  status(project: string): RcStatus;
  list(): RcStatus[];
  shutdown(): Promise<void>;
}

/** `claude remote-control` の引数を組み立てる。 */
export function buildRcArgs(
  project: ProjectConfig,
  _cfg: Config["remoteControl"],
  opts: { continue: boolean },
): string[] {
  return [
    "remote-control",
    "--name",
    project.name,
    "--spawn",
    project.spawn,
    "--permission-mode",
    project.permissionMode,
    ...(project.capacity ? ["--capacity", String(project.capacity)] : []),
    ...(opts.continue ? ["--continue"] : []),
  ];
}

const SESSION_URL = /https:\/\/claude\.ai\/code\/session_[A-Za-z0-9_-]+/;
const ANY_URL = /https:\/\/[^\s"'<>)\]]+/g;

/** 1 行から session URL と environment URL を拾う。 */
export function extractUrls(text: string): { sessionUrl?: string; environmentUrl?: string } {
  const out: { sessionUrl?: string; environmentUrl?: string } = {};
  const s = SESSION_URL.exec(text);
  if (s) out.sessionUrl = s[0];
  for (const u of text.match(ANY_URL) ?? []) {
    if (u.includes("environment=env_")) {
      out.environmentUrl = u;
      break;
    }
  }
  return out;
}

/** 接続完了の行か。 */
export function detectConnected(line: string): boolean {
  return /\bConnected\b/.test(line);
}

// eslint-disable-next-line no-control-regex
/** 初回起動時に claude remote-control が出す有効化確認。改行なしで入力待ちになる。 */
export const CONSENT_PROMPT = "Enable Remote Control? (y/n)";

/** exit 後に close が来ない（孫プロセスが pipe を握っている等）場合にログを閉じるまでの待ち。 */
const CLOSE_WAIT_MS = 2000;

const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

interface Entry {
  project: ProjectConfig;
  status: RcStatus;
  child: ChildLike | null;
  timer: NodeJS.Timeout | null;
  stopRequested: boolean;
  /** stop() を呼んだ回数（start の await 中に stop された検出用）。 */
  stopSeq: number;
  /** launch ごとの世代。古い child のイベントが現在の状態を触らないための印。 */
  gen: number;
  /** 現在の child が終了済みか。 */
  exited: Promise<void> | null;
  logStream: WriteStream | null;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export function createRemoteControlSupervisor(opts: {
  config: Config;
  log: Logger;
  spawnImpl?: SpawnImpl;
}): RemoteControlSupervisor {
  const { config, log } = opts;
  const spawnImpl: SpawnImpl = opts.spawnImpl ?? ((c, a, o) => nodeSpawn(c, a, o) as unknown as ChildLike);
  const rc = config.remoteControl;
  const entries = new Map<string, Entry>();
  for (const p of config.projects) {
    entries.set(p.name, {
      project: p,
      status: {
        project: p.name,
        path: p.path,
        state: "stopped",
        pid: null,
        sessionUrl: null,
        environmentUrl: null,
        restarts: 0,
        lastExit: null,
        startedAt: null,
        args: null,
      },
      child: null,
      timer: null,
      stopRequested: false,
      stopSeq: 0,
      gen: 0,
      exited: null,
      logStream: null,
    });
  }

  const get = (name: string): Entry => {
    const e = entries.get(name);
    if (!e) throw new Error(`未定義の project: ${name}`);
    return e;
  };
  const snapshot = (e: Entry): RcStatus => ({ ...e.status, args: e.status.args ? [...e.status.args] : null });

  const childEnv = (): NodeJS.ProcessEnv => {
    const env = { ...process.env };
    delete env.ANTHROPIC_API_KEY;
    delete env.TMUX;
    return env;
  };

  /** 子プロセスを 1 本起動して監視を付ける。 */
  const launch = (e: Entry, useContinue: boolean): void => {
    const name = e.project.name;
    const args = buildRcArgs(e.project, rc, { continue: useContinue });
    e.stopRequested = false;
    const gen = ++e.gen;
    e.status = {
      ...e.status,
      state: "starting",
      pid: null,
      sessionUrl: null,
      environmentUrl: null,
      startedAt: new Date().toISOString(),
      args,
    };
    delete e.status.lastError;

    const logStream = createWriteStream(join(config.logDir, `${name}.log`), { flags: "a" });
    logStream.on("error", (err) => log(`ログ書込失敗: project=${name} ${err.message}`));
    e.logStream = logStream;

    let child: ChildLike;
    try {
      child = spawnImpl(rc.claude, args, { cwd: e.project.path, env: childEnv(), stdio: ["pipe", "pipe", "pipe"] });
    } catch (err) {
      e.status.state = "error";
      e.status.lastError = `起動失敗: ${(err as Error).message}`;
      logStream.end();
      e.logStream = null;
      log(`remote-control 起動失敗: project=${name} ${(err as Error).message}`);
      return;
    }
    e.child = child;
    e.status.pid = child.pid ?? null;
    log(`remote-control 起動: project=${name} pid=${child.pid ?? "?"} args=${args.join(" ")}`);

    let resolveExited!: () => void;
    e.exited = new Promise<void>((r) => (resolveExited = r));

    const onLine = (line: string): void => {
      const clean = line.replace(ANSI, "");
      const urls = extractUrls(clean);
      if (urls.sessionUrl) e.status.sessionUrl = urls.sessionUrl;
      if (urls.environmentUrl) e.status.environmentUrl = urls.environmentUrl;
      if (e.status.state === "starting" && detectConnected(clean)) {
        e.status.state = "connected";
        log(`remote-control 接続: project=${name}`);
      }
    };
    // stdin は子の生存中ずっと開けておく（閉じると確認待ちで固まる）。EPIPE は無視する
    child.stdin?.on("error", () => {});
    let consentSent = false;
    let consentTail = "";
    const answerConsent = (chunk: string): void => {
      if (!rc.autoConsent || consentSent || !child.stdin) return;
      consentTail = (consentTail + chunk).replace(ANSI, "").slice(-200);
      if (!consentTail.includes(CONSENT_PROMPT)) return;
      consentSent = true;
      log(`remote-control の有効化確認に y を送信: project=${name}`);
      child.stdin.write("y\n", () => {});
    };
    const attach = (s: Readable | null, parse: boolean): void => {
      if (!s) return;
      let buf = "";
      s.setEncoding("utf8");
      s.on("data", (chunk: string) => {
        if (!logStream.writableEnded) logStream.write(chunk);
        if (!parse) return;
        answerConsent(chunk);
        buf += chunk;
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const l of lines) onLine(l);
      });
      // 改行で終わらない最後の行も拾う
      s.on("end", () => {
        if (parse && buf) onLine(buf);
        buf = "";
      });
    };
    attach(child.stdout, true);
    attach(child.stderr, false);

    // 状態の確定（exit / spawn 失敗）。古い世代は自分の後始末だけで、現在の entry は触らない
    let done = false;
    const finish = (): boolean => {
      if (done) return false;
      done = true;
      if (e.gen === gen) {
        e.child = null;
        e.status.pid = null;
      }
      resolveExited();
      return true;
    };
    // ログ stream は stdout / stderr が閉じる close で閉じる（exit 直後の出力を落とさない）
    let logClosed = false;
    let closeTimer: NodeJS.Timeout | null = null;
    const closeLog = (): void => {
      if (logClosed) return;
      logClosed = true;
      if (closeTimer) clearTimeout(closeTimer);
      logStream.end();
      if (e.logStream === logStream) e.logStream = null;
    };

    child.on("error", (err) => {
      if (child.pid !== undefined) {
        // 起動済みの子の error（kill 失敗など）。子は生きているので追跡を続ける
        log(`remote-control エラー（継続）: project=${name} ${err.message}`);
        return;
      }
      if (!finish()) return;
      closeLog();
      if (e.gen !== gen) return;
      e.status.state = "error";
      e.status.lastError = `起動失敗: ${err.message}`;
      log(`remote-control エラー: project=${name} ${err.message}`);
    });

    child.on("exit", (code, signal) => {
      if (!finish()) return;
      closeTimer = setTimeout(closeLog, CLOSE_WAIT_MS);
      closeTimer.unref();
      if (e.gen !== gen) {
        log(`古い remote-control の終了を無視: project=${name} code=${code ?? "null"} signal=${signal ?? "null"}`);
        return;
      }
      e.status.lastExit = { code, signal: signal ?? null, at: new Date().toISOString() };
      log(`remote-control 終了: project=${name} code=${code ?? "null"} signal=${signal ?? "null"}`);
      if (e.stopRequested) {
        e.status.state = "stopped";
        return;
      }
      if (e.status.restarts < rc.maxRestarts) {
        e.status.restarts++;
        e.status.state = "starting";
        log(`remote-control 再起動予約: project=${name} ${e.status.restarts}/${rc.maxRestarts} delay=${rc.restartDelayMs}ms`);
        e.timer = setTimeout(() => {
          e.timer = null;
          launch(e, rc.continueOnRestart);
        }, rc.restartDelayMs);
      } else {
        e.status.state = "error";
        e.status.lastError = "再起動回数の上限";
        log(`remote-control 再起動上限: project=${name}`);
      }
    });

    child.on("close", closeLog);
  };

  const isActive = (e: Entry): boolean => e.status.state === "starting" || e.status.state === "connected";

  let closing = false;

  const start = async (name: string): Promise<RcStatus> => {
    const e = get(name);
    if (isActive(e) || closing) return snapshot(e);
    const stopSeq = e.stopSeq;
    await mkdir(config.logDir, { recursive: true });
    // await 中に別の start が割り込んだ場合の二重起動を避ける
    if (isActive(e)) return snapshot(e);
    // await 中に stop / shutdown された場合は起動しない
    if (closing || e.stopSeq !== stopSeq) {
      log(`remote-control 起動中止（停止要求あり）: project=${name}`);
      return snapshot(e);
    }
    e.status.restarts = 0;
    launch(e, false);
    return snapshot(e);
  };

  const stop = async (name: string): Promise<RcStatus> => {
    const e = get(name);
    e.stopRequested = true;
    e.stopSeq++;
    if (e.timer) {
      clearTimeout(e.timer);
      e.timer = null;
    }
    const child = e.child;
    if (child && e.exited) {
      const exited = e.exited;
      log(`remote-control 停止要求: project=${name} SIGTERM`);
      child.kill("SIGTERM");
      const graceful = await Promise.race([exited.then(() => true), sleep(rc.stopGraceMs).then(() => false)]);
      if (!graceful) {
        log(`remote-control SIGKILL: project=${name} (${rc.stopGraceMs}ms 以内に終了せず)`);
        child.kill("SIGKILL");
        await Promise.race([exited, sleep(5000)]);
      }
    }
    e.status.state = "stopped";
    e.status.restarts = 0;
    return snapshot(e);
  };

  return {
    start,
    stop,
    status: (name) => snapshot(get(name)),
    list: () => [...entries.values()].map(snapshot),
    shutdown: async () => {
      closing = true;
      await Promise.all([...entries.keys()].map((n) => stop(n)));
    },
  };
}
