import { spawn as nodeSpawn } from "node:child_process";
import { createWriteStream, type WriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Readable, Writable } from "node:stream";
import type { ResolvedClaude } from "./claude-path.js";
import { loadConfigSync, type Config, type ProjectConfig } from "./config.js";
import type { Logger } from "./log.js";
import { reapOrphans } from "./reap.js";
import type { Core } from "./core.js";
import type { SessionTokens } from "./session-auth.js";
import {
  buildWrapperArgs,
  encodeInput,
  encodeResize,
  encodeStop,
  findSessionUrl,
  mcpConfigJson,
  parseWrapperLine,
  resolveWrapperPath,
  TEXT_WINDOW,
  windowConnected,
} from "./wrapper.js";
import { statusLineCommand, statusLineSettingsJson, statusLineUrl } from "./status-line.js";

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
  /** この起動で `--append-system-prompt`（session の instructions）を付けたか。本文は持たない。 */
  instructions: boolean;
  /** 起動に使う claude 実行ファイルとその決定元。 */
  claude: ResolvedClaude;
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
  options: { cwd: string; env: NodeJS.ProcessEnv; stdio: ["pipe", "pipe", "pipe"]; detached: boolean },
) => ChildLike;

/** `--append-system-prompt` の値を「<N 文字>」に置き換えた引数列（status / log 用）。 */
export function redactAppendSystemPrompt(args: string[]): string[] {
  const i = args.indexOf("--append-system-prompt");
  if (i < 0 || i + 1 >= args.length) return [...args];
  return [...args.slice(0, i + 1), `<${args[i + 1].length} 文字>`, ...args.slice(i + 2)];
}

/** 子へ signal を送る。既定は process group ごと（孫まで止める）。 */
export type KillImpl = (child: ChildLike, signal: NodeJS.Signals) => void;

/**
 * 実 spawn（detached: true = setsid、pgid = 子の pid）用の kill。
 * process group 全体へ送り、group が無い / 権限が無い場合は子 1 本へ送る。
 */
export const groupKill: KillImpl = (child, signal) => {
  if (child.pid !== undefined && child.pid > 1) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ESRCH" && code !== "EPERM") throw err;
    }
  }
  child.kill(signal);
};

export interface RemoteControlSupervisor {
  /**
   * 起動する。resume: true なら `--continue` で前回の会話に復帰を試み、接続前に早期終了したら素の起動へ fallback する
   * （claude は約 4 時間以内の記録が無いと --continue で error exit する）。
   */
  start(project: string, opts?: { resume?: boolean }): Promise<RcStatus>;
  /**
   * 実行中に project を足す（起動はしない）。同名は拒否。remove で外せるのはこの add で足したものだけ。
   * wrapper: true なら pty wrapper 経由の対話型（`claude --remote-control`）で起動する。省略は従来の `claude remote-control`。
   */
  add(project: ProjectConfig, opts?: { wrapper?: boolean; instructions?: string; addDirs?: string[] }): void;
  /** add で足した project を停止して外す。config 由来の project は外せない。 */
  remove(name: string): Promise<void>;
  /** 追加指示（`--append-system-prompt` の値）を差し替える。次の起動から効く（動いている session は起動し直さない）。空で無し。 */
  setInstructions(name: string, instructions: string): void;
  /** 参照フォルダ（`--add-dir` の値）を差し替える。次の起動から効く。空配列で無し。 */
  setAddDirs(name: string, addDirs: string[]): void;
  stop(project: string): Promise<RcStatus>;
  status(project: string): RcStatus;
  list(): RcStatus[];
  shutdown(): Promise<void>;
  /** 生きている子全てへ同期で signal を送る（exit handler / 強制終了タイマー用。待たない）。 */
  killAllSync(signal: NodeJS.Signals): void;
}

/**
 * `claude remote-control` の引数を組み立てる。
 * claude 2.1.312 は --continue を --spawn / --capacity と併用するとエラー終了する
 * ("--session-id and --continue cannot be used with --spawn, --capacity, or --create-session-in-dir.")。
 * そのため spawn が未指定 / same-dir かつ capacity 未指定の時は --spawn / --capacity を付けず、--continue を許す。
 * spawn が worktree / session、または capacity 指定がある時は --spawn / --capacity を付け、--continue は付けない。
 */
export function buildRcArgs(
  project: ProjectConfig,
  _cfg: Config["remoteControl"],
  opts: { continue: boolean },
): string[] {
  const plain = (project.spawn === undefined || project.spawn === "same-dir") && !project.capacity;
  return [
    "remote-control",
    "--name",
    project.name,
    ...(plain ? [] : ["--spawn", project.spawn ?? "same-dir"]),
    "--permission-mode",
    project.permissionMode,
    ...(project.capacity ? ["--capacity", String(project.capacity)] : []),
    ...(plain && opts.continue ? ["--continue"] : []),
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

/** --continue の起動がこの時間内に接続前で終了したら「復帰できなかった」とみなし、素の起動へ fallback する。 */
export const CONTINUE_FALLBACK_WINDOW_MS = 30_000;

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
  /** pty wrapper 経由で起動する entry か。 */
  wrapper: boolean;
  /** `--append-system-prompt` に渡す追加指示。空なら付けない。再起動・--continue でも同じ値を使う。 */
  instructions: string;
  /** `--add-dir` に 1 つずつ渡す参照フォルダ。空なら付けない。再起動・--continue でも同じ値を使う。 */
  addDirs: string[];
}

/** wrapper 経由の起動に必要なもの。 */
export interface WrapperDeps {
  core: Core;
  tokens: SessionTokens;
  /** wrapper の実行ファイル。省略時は resolveWrapperPath()。 */
  path?: string;
  /** session 向け MCP 窓口の URL。http で待ち受けていない（stdio）時は null で、その時は --mcp-config を付けない。 */
  mcpUrl: () => string | null;
  /** statusLine のサブコマンドが center 自身を再実行する argv。省略時は実行中の center 自身（テスト用の差し替え）。 */
  statusLineSelf?: string[];
}

/**
 * 子プロセスの環境変数を合成する。優先順は base < remoteControl.env < project.env。
 * 合成後に ANTHROPIC_API_KEY（remote-control が失敗する）と TMUX を除く（config からは注入できない）。
 */
export function mergeChildEnv(
  base: NodeJS.ProcessEnv,
  remoteControlEnv?: Record<string, string>,
  projectEnv?: Record<string, string>,
): NodeJS.ProcessEnv {
  const env = { ...base, ...remoteControlEnv, ...projectEnv };
  delete env.ANTHROPIC_API_KEY;
  delete env.TMUX;
  return env;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export function createRemoteControlSupervisor(opts: {
  config: Config;
  /**
   * 指定すると、session を起動するたび（新規・再起動・--continue・resume 失敗後の素の起動）にこの config ファイルを読み直し、
   * remoteControl の項目のうち model / env / autoConsent / maxRestarts / restartDelayMs / continueOnRestart をその時点の値にする。
   * 読めない・不正な時は直前に読めた値（初回は config）で起動し、理由を log に残す。
   */
  configPath?: string;
  log: Logger;
  spawnImpl?: SpawnImpl;
  /** 子への signal 送信。省略時は、実 spawn なら process group 宛て、spawnImpl 注入時は child.kill。 */
  killImpl?: KillImpl;
  /** start 前に同じ project の孤児を回収する処理。省略時は reapOrphans（ps 照合）。spawnImpl 注入時は何もしない。 */
  reap?: (project: string) => Promise<unknown>;
  /** 解決済みの claude。省略時は config 指定、なければ PATH 任せの `claude`。 */
  claude?: ResolvedClaude;
  /** wrapper 経由で起動する entry（add の wrapper: true）に必要なもの。 */
  wrapper?: WrapperDeps;
}): RemoteControlSupervisor {
  const { config, log } = opts;
  const spawnImpl: SpawnImpl = opts.spawnImpl ?? ((c, a, o) => nodeSpawn(c, a, o) as unknown as ChildLike);
  const killImpl: KillImpl = opts.killImpl ?? (opts.spawnImpl ? (c, sig) => void c.kill(sig) : groupKill);
  const reap =
    opts.reap ?? (opts.spawnImpl ? async () => {} : (project: string) => reapOrphans(project, { log }));
  const rc = config.remoteControl;
  const claude: ResolvedClaude =
    opts.claude ?? (rc.claude ? { path: rc.claude, source: "config" } : { path: "claude", source: "PATH" });
  const entries = new Map<string, Entry>();
  /** add() で足した project の名前（remove できるのはこれだけ）。 */
  const dynamic = new Set<string>();
  const newEntry = (p: ProjectConfig, wrapper = false, instructions = "", addDirs: string[] = []): Entry => ({
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
        instructions: false,
        claude,
      },
      child: null,
      timer: null,
      stopRequested: false,
      stopSeq: 0,
      gen: 0,
      exited: null,
      logStream: null,
      wrapper,
      instructions,
      addDirs,
  });
  for (const p of config.projects) entries.set(p.name, newEntry(p));

  const get = (name: string): Entry => {
    const e = entries.get(name);
    if (!e) throw new Error(`未定義の project: ${name}`);
    return e;
  };
  const snapshot = (e: Entry): RcStatus => ({ ...e.status, args: e.status.args ? [...e.status.args] : null });

  const childEnv = (p: ProjectConfig, cur: Config["remoteControl"]): NodeJS.ProcessEnv =>
    mergeChildEnv(process.env, cur.env, p.env);

  /** 直前に読めた remoteControl。読み直しに失敗した時の起動に使う。 */
  let lastGoodRc: Config["remoteControl"] = rc;
  /** launch のたびに config ファイルから remoteControl を読み直す（configPath 未指定なら起動時の値）。 */
  const currentRc = (project: string): Config["remoteControl"] => {
    if (!opts.configPath) return rc;
    try {
      lastGoodRc = loadConfigSync(opts.configPath).remoteControl;
    } catch (err) {
      log(`config の読み直しに失敗。直前の値で起動: project=${project} ${(err as Error).message}`);
    }
    return lastGoodRc;
  };

  /** 子プロセスを 1 本起動して監視を付ける。 */
  const launch = (e: Entry, useContinue: boolean, fallback = false): void => {
    const name = e.project.name;
    const rc = currentRc(name);
    const wd = e.wrapper ? opts.wrapper : undefined;
    let command = claude.path;
    let args: string[];
    let env = childEnv(e.project, rc);
    if (e.wrapper) {
      if (!wd) {
        e.status.state = "error";
        e.status.lastError = "起動失敗: wrapper の設定が無い";
        return;
      }
      wd.core.register(name);
      const mcpUrl = wd.mcpUrl();
      if (!mcpUrl) log(`session 向け MCP 窓口が無いので bantou の MCP を付けない（messenger のみ）: project=${name}`);
      args = buildWrapperArgs({
        claudePath: claude.path,
        name,
        permissionMode: e.project.permissionMode,
        mcpConfig: mcpConfigJson(mcpUrl, name),
        // statusLine は center のものを渡す（利用者の statusLine 設定より優先される）。窓口が無い（stdio）時は付けない
        settings: mcpUrl ? statusLineSettingsJson(statusLineCommand(statusLineUrl(mcpUrl, name), wd.statusLineSelf)) : null,
        resume: useContinue,
        ...(rc.model ? { model: rc.model } : {}),
        ...(e.instructions ? { appendSystemPrompt: e.instructions } : {}),
        ...(e.addDirs.length ? { addDirs: e.addDirs } : {}),
        ...(wd.core.size(name) ?? {}),
      });
      command = wd.path ?? resolveWrapperPath();
      env = { ...env, BANTOU_SESSION_TOKEN: wd.tokens.issue(name) };
    } else {
      args = buildRcArgs(e.project, rc, { continue: useContinue });
    }
    // 追加指示の本文は status にも log にも出さない（長さだけ）
    const shownArgs = redactAppendSystemPrompt(args);
    e.stopRequested = false;
    const gen = ++e.gen;
    e.status = {
      ...e.status,
      state: "starting",
      pid: null,
      sessionUrl: null,
      environmentUrl: null,
      startedAt: new Date().toISOString(),
      args: shownArgs,
      instructions: e.wrapper && !!e.instructions,
    };
    delete e.status.lastError;

    const logStream = createWriteStream(join(config.logDir, `${name}.log`), { flags: "a" });
    logStream.on("error", (err) => log(`ログ書込失敗: project=${name} ${err.message}`));
    e.logStream = logStream;

    let child: ChildLike;
    try {
      child = spawnImpl(command, args, { cwd: e.project.path, env, stdio: ["pipe", "pipe", "pipe"], detached: true });
    } catch (err) {
      wd?.tokens.revoke(name);
      e.status.state = "error";
      e.status.lastError = `起動失敗: ${(err as Error).message}`;
      logStream.end();
      e.logStream = null;
      log(`remote-control 起動失敗: project=${name} ${(err as Error).message}`);
      return;
    }
    e.child = child;
    e.status.pid = child.pid ?? null;
    log(`remote-control 起動: project=${name} pid=${child.pid ?? "?"} args=${shownArgs.join(" ")}`);

    let resolveExited!: () => void;
    e.exited = new Promise<void>((r) => (resolveExited = r));

    const launchedAt = Date.now();
    let connectedSeen = false;
    /** 直近の非空行（stdout / stderr）。接続前に終了した時の原因表示に使う（例: Workspace not trusted）。 */
    let lastLine = "";
    const onLine = (line: string): void => {
      const clean = line.replace(ANSI, "");
      const urls = extractUrls(clean);
      if (urls.sessionUrl) e.status.sessionUrl = urls.sessionUrl;
      if (urls.environmentUrl) e.status.environmentUrl = urls.environmentUrl;
      if (e.status.state === "starting" && detectConnected(clean)) {
        e.status.state = "connected";
        connectedSeen = true;
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
        const tail = chunk.replace(ANSI, "").split("\n").map((l) => l.trim()).filter(Boolean).pop();
        if (tail) lastLine = tail.slice(0, 300);
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
    /** wrapper の stdout（1 行 1 JSON）。output は core へ、text は窓に溜めて照合する。 */
    let wrapperExit: { code: number | null; signal: string | null } | null = null;
    const attachWrapperOut = (s: Readable | null): void => {
      if (!s || !wd) return;
      let buf = "";
      let win = "";
      let wconsent = false;
      const onText = (text: string): void => {
        if (!logStream.writableEnded) logStream.write(text);
        const tail = text.split("\n").map((l) => l.trim()).filter(Boolean).pop();
        if (tail) lastLine = tail.slice(0, 300);
        win = (win + text).slice(-TEXT_WINDOW);
        if (rc.autoConsent && !wconsent && win.includes(CONSENT_PROMPT)) {
          wconsent = true;
          log(`remote-control の有効化確認に y を送信: project=${name}`);
          child.stdin?.write(encodeInput(Buffer.from("y\r")), () => {});
        }
        const url = findSessionUrl(win);
        if (url) e.status.sessionUrl = url;
        if (e.status.state === "starting" && windowConnected(win)) {
          e.status.state = "connected";
          connectedSeen = true;
          log(`remote-control 接続: project=${name}`);
        }
      };
      const onMsg = (line: string): void => {
        const m = parseWrapperLine(line);
        if (!m) {
          if (line.trim()) log(`wrapper の不明な行を無視: project=${name} ${line.slice(0, 100)}`);
          return;
        }
        if (m.t === "output") wd.core.push(name, m.data);
        else if (m.t === "text") onText(m.data);
        else if (m.t === "exit") wrapperExit = { code: m.code, signal: m.signal };
      };
      s.setEncoding("utf8");
      s.on("data", (chunk: string) => {
        buf += chunk;
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const l of lines) onMsg(l);
      });
      s.on("end", () => {
        if (buf) onMsg(buf);
        buf = "";
      });
    };
    if (wd) {
      child.stdin?.on("error", () => {});
      attachWrapperOut(child.stdout);
      attach(child.stderr, false);
      wd.core.attach(name, {
        input: (data) => void child.stdin?.write(encodeInput(data), () => {}),
        resize: (cols, rows) => void child.stdin?.write(encodeResize(cols, rows), () => {}),
      });
    } else {
      attach(child.stdout, true);
      attach(child.stderr, false);
    }

    // 状態の確定（exit / spawn 失敗）。古い世代は自分の後始末だけで、現在の entry は触らない
    let done = false;
    const finish = (): boolean => {
      if (done) return false;
      done = true;
      if (e.gen === gen) {
        e.child = null;
        e.status.pid = null;
        if (wd) {
          wd.core.detach(name);
          wd.tokens.revoke(name);
        }
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

    const handleExit = (rawCode: number | null, rawSignal: NodeJS.Signals | null): void => {
      // wrapper は子（claude）の終了コードを exit メッセージで伝える。あればそちらが実際の終了
      const code = wrapperExit ? wrapperExit.code : rawCode;
      const signal = wrapperExit ? (wrapperExit.signal as NodeJS.Signals | null) : rawSignal;
      if (e.gen !== gen) {
        log(`古い remote-control の終了を無視: project=${name} code=${code ?? "null"} signal=${signal ?? "null"}`);
        return;
      }
      e.status.lastExit = { code, signal: signal ?? null, at: new Date().toISOString() };
      if (!connectedSeen && !e.stopRequested && lastLine) e.status.lastError = `接続前に終了: ${lastLine}`;
      log(`remote-control 終了: project=${name} code=${code ?? "null"} signal=${signal ?? "null"}`);
      if (e.stopRequested) {
        e.status.state = "stopped";
        return;
      }
      if (fallback && useContinue && !connectedSeen && Date.now() - launchedAt < CONTINUE_FALLBACK_WINDOW_MS) {
        log(`--continue で復帰できず早期終了、素の起動へ fallback: project=${name}`);
        launch(e, false);
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
        e.status.lastError = e.status.lastError ? `再起動回数の上限（${e.status.lastError}）` : "再起動回数の上限";
        log(`remote-control 再起動上限: project=${name}`);
      }
    };

    let exitHandled = false;
    let pendingExit: [number | null, NodeJS.Signals | null] | null = null;
    const runExit = (): void => {
      if (exitHandled || !pendingExit) return;
      exitHandled = true;
      handleExit(...pendingExit);
    };
    child.on("exit", (code, signal) => {
      if (!finish()) return;
      closeTimer = setTimeout(closeLog, CLOSE_WAIT_MS);
      closeTimer.unref();
      pendingExit = [code, signal];
      if (!wd) {
        runExit();
        return;
      }
      // wrapper は exit 直前の出力（接続判定・exit メッセージ）が stdout に残っているので、閉じるまで待ってから判定する
      const t = setTimeout(runExit, CLOSE_WAIT_MS);
      t.unref();
    });

    child.on("close", () => {
      closeLog();
      if (wd) runExit();
    });
  };

  const isActive = (e: Entry): boolean => e.status.state === "starting" || e.status.state === "connected";

  let closing = false;

  const start = async (name: string, startOpts: { resume?: boolean } = {}): Promise<RcStatus> => {
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
    // 前の center が残した同名の孤児を止めてから起動する（重複起動を避ける）
    try {
      await reap(name);
    } catch (err) {
      log(`孤児回収に失敗（起動は続行）: project=${name} ${(err as Error).message}`);
    }
    if (isActive(e)) return snapshot(e);
    if (closing || e.stopSeq !== stopSeq) {
      log(`remote-control 起動中止（停止要求あり）: project=${name}`);
      return snapshot(e);
    }
    e.status.restarts = 0;
    launch(e, startOpts.resume === true, startOpts.resume === true);
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
      if (e.wrapper) {
        // wrapper には stop メッセージで子（claude）を止めさせる（wrapper が SIGTERM → SIGKILL を扱う）
        log(`remote-control 停止要求: project=${name} stop メッセージ`);
        child.stdin?.write(encodeStop(), () => {});
      } else {
        log(`remote-control 停止要求: project=${name} SIGTERM`);
        killImpl(child, "SIGTERM");
      }
      const graceful = await Promise.race([exited.then(() => true), sleep(rc.stopGraceMs).then(() => false)]);
      if (!graceful) {
        log(`remote-control SIGKILL: project=${name} (${rc.stopGraceMs}ms 以内に終了せず)`);
        killImpl(child, "SIGKILL");
        await Promise.race([exited, sleep(5000)]);
      }
    }
    e.status.state = "stopped";
    e.status.restarts = 0;
    return snapshot(e);
  };

  const add = (project: ProjectConfig, addOpts: { wrapper?: boolean; instructions?: string; addDirs?: string[] } = {}): void => {
    if (entries.has(project.name)) throw new Error(`project が既に存在: ${project.name}`);
    if (addOpts.wrapper && !opts.wrapper) throw new Error("wrapper の設定が無いので wrapper 起動の project は足せない");
    entries.set(project.name, newEntry(project, addOpts.wrapper === true, addOpts.instructions, addOpts.addDirs));
    if (addOpts.wrapper) opts.wrapper?.core.register(project.name);
    dynamic.add(project.name);
  };

  const setInstructions = (name: string, instructions: string): void => {
    get(name).instructions = instructions;
  };

  const setAddDirs = (name: string, addDirs: string[]): void => {
    get(name).addDirs = [...addDirs];
  };

  const remove = async (name: string): Promise<void> => {
    get(name);
    if (!dynamic.has(name)) throw new Error(`config 由来の project は外せない: ${name}`);
    await stop(name);
    if (opts.wrapper && entries.get(name)?.wrapper) {
      opts.wrapper.core.remove(name);
      opts.wrapper.tokens.revoke(name);
    }
    entries.delete(name);
    dynamic.delete(name);
  };

  return {
    start,
    add,
    remove,
    setInstructions,
    setAddDirs,
    stop,
    status: (name) => snapshot(get(name)),
    list: () => [...entries.values()].map(snapshot),
    shutdown: async () => {
      closing = true;
      await Promise.all([...entries.keys()].map((n) => stop(n)));
    },
    killAllSync: (signal) => {
      for (const e of entries.values()) {
        if (!e.child) continue;
        try {
          // wrapper 経由の子（claude）は wrapper に止めさせる。signal だけでは pty 側が残り得る
          if (e.wrapper) e.child.stdin?.write(encodeStop());
          killImpl(e.child, signal);
        } catch {
          // 既に終了している等。最後の砦なので握りつぶす
        }
      }
    },
  };
}
