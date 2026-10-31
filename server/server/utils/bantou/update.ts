import { execFile } from "node:child_process";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  isValidServerVersion,
  MESSENGER_PROTOCOL,
  PROTOCOL_VERSION,
  type HelloResultReply,
  type UpdateFailure,
  type UpdateProgress,
  type UpdateResultReply,
  type UpdateRunning,
  type ErrorCode,
} from "@agent-hand/bantou-protocol";

/** supervisor との取り決めのファイル名（bin/supervisor.mjs と同じ）。 */
export const UPDATE_FILE = "update.json";
export const READY_FILE = "server.ready";

/** 取得確認（npx）の打ち切り。 */
export const FETCH_TIMEOUT_MS = 300_000;
/** 待機中に「全部終わったか」を見る間隔。 */
export const POLL_MS = 1000;

/** update.json の中身。restart = 子を spec で入れ替える合図、failed = 直近の更新の失敗。 */
export type UpdateFile =
  | { state: "restart"; to: string; spec: string }
  | { state: "failed"; to: string; error: string; at: string };

/** code 付きで返す更新系のエラー。daemon が ErrorReply にする。 */
export class UpdateError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
  }
}

/** config の update.spec の {version} を置き換える。版は呼び出し前に検証済みであること。 */
export function buildSpec(template: string, version: string): string {
  return template.split("{version}").join(version);
}

/** 取得確認のコマンド。`npx -y --package=<spec> -- bantou --version`。 */
export function fetchCommand(spec: string): { cmd: string; args: string[] } {
  return { cmd: "npx", args: ["-y", `--package=${spec}`, "--", "bantou", "--version"] };
}

export type FetchRunner = (cmd: string, args: string[], timeoutMs: number) => Promise<{ stdout: string }>;

const defaultFetchRunner: FetchRunner = (cmd, args, timeoutMs) =>
  new Promise((resolve, reject) => {
    execFile(cmd, args, { encoding: "utf8", timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: 1 << 20 }, (err, stdout, stderr) => {
      if (err) {
        const detail = (stderr || "").trim().split("\n").slice(-3).join(" ") || err.message;
        reject(new Error(detail));
        return;
      }
      resolve({ stdout });
    });
  });

/**
 * 更新先を実際に取得して確かめる。npx が exit 0 で、出力の最終行が要求した版なら成功。
 * 失敗は UpdateError(update_failed) を投げる。
 */
export async function verifyFetch(spec: string, version: string, run: FetchRunner = defaultFetchRunner): Promise<void> {
  const { cmd, args } = fetchCommand(spec);
  let stdout: string;
  try {
    ({ stdout } = await run(cmd, args, FETCH_TIMEOUT_MS));
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    throw new UpdateError("update_failed", `版 ${version} を取得できない (${spec}): ${detail}`, false);
  }
  const got = stdout.trim().split("\n").pop()?.trim() ?? "";
  if (got !== version) {
    throw new UpdateError("update_failed", `取得した版が要求と違う: 要求=${version} 取得=${got || "(空)"} (${spec})`, false);
  }
}

// -- ファイル（workspace 直下） ------------------------------------------------------

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(value) + "\n");
  await rename(tmp, path);
}

export async function readUpdateFile(workspace: string): Promise<UpdateFile | undefined> {
  try {
    const v = JSON.parse(await readFile(join(workspace, UPDATE_FILE), "utf8")) as Record<string, unknown>;
    if (v.state === "restart" && typeof v.to === "string" && typeof v.spec === "string") {
      return { state: "restart", to: v.to, spec: v.spec };
    }
    if (v.state === "failed" && typeof v.to === "string" && typeof v.error === "string" && typeof v.at === "string") {
      return { state: "failed", to: v.to, error: v.error, at: v.at };
    }
  } catch {
    // 無い・壊れている
  }
  return undefined;
}

export async function writeUpdateFile(workspace: string, f: UpdateFile): Promise<void> {
  await writeJsonAtomic(join(workspace, UPDATE_FILE), f);
}

export async function removeUpdateFile(workspace: string): Promise<void> {
  await rm(join(workspace, UPDATE_FILE), { force: true });
}

export async function writeReadyFile(workspace: string, version: string): Promise<void> {
  await writeJsonAtomic(join(workspace, READY_FILE), { pid: process.pid, version });
}

export async function removeReadyFile(workspace: string): Promise<void> {
  const path = join(workspace, READY_FILE);
  try {
    const cur = JSON.parse(await readFile(path, "utf8")) as { pid?: unknown };
    if (cur.pid === process.pid) await rm(path, { force: true });
  } catch {
    // 無ければよい
  }
}

// -- 更新の状態機械 ---------------------------------------------------------------

export interface UpdateControllerDeps {
  workspace: string;
  /** 自分の npm 版。 */
  serverVersion: string;
  /** config の update.spec。 */
  specTemplate: string;
  /** 実行中の件数（cap / worker / report 起因）。 */
  running: () => UpdateRunning;
  /** running の件数に出ない、受け付け済みで未登録の指示の数（0 になるまで再起動しない）。 */
  extraBusy?: () => number;
  /** 取得確認。既定は npx。 */
  fetch?: (spec: string, version: string) => Promise<void>;
  /** 再起動のための終了を頼む（plugin の shutdown）。 */
  requestExit: (reason: string) => void;
  log: (msg: string) => void;
  pollMs?: number;
  now?: () => Date;
}

export interface UpdateController {
  /** 更新が進行中（待機・再起動）か。この間 kick_cap は断る。 */
  isUpdating(): boolean;
  progress(): UpdateProgress | null;
  hello(): HelloResultReply;
  /** update_server の処理。版の検証・取得確認を経て待機に入る。失敗は UpdateError を投げる。 */
  request(version: string): Promise<UpdateResultReply>;
  /** 保存してある直近の失敗を読む（起動時）。 */
  loadLastFailure(): Promise<void>;
  /** 待機の監視を止める（終了処理）。 */
  close(): void;
}

export function createUpdateController(deps: UpdateControllerDeps): UpdateController {
  const { workspace, serverVersion, log } = deps;
  const fetchFn = deps.fetch ?? ((spec: string, version: string) => verifyFetch(spec, version));
  const now = deps.now ?? (() => new Date());
  const pollMs = deps.pollMs ?? POLL_MS;
  let state: { phase: "waiting" | "restarting"; to: string; spec: string } | null = null;
  let fetching: { to: string; p: Promise<void> } | null = null;
  let lastFailure: UpdateFailure | null = null;
  let timer: ReturnType<typeof setInterval> | undefined;

  const currentState = (): typeof state => state;

  const progress = (): UpdateProgress | null =>
    state ? { state: state.phase, from: serverVersion, to: state.to, running: deps.running() } : null;

  const idle = (): boolean => {
    const r = deps.running();
    return r.caps === 0 && r.workers === 0 && r.reports === 0 && (deps.extraBusy?.() ?? 0) === 0;
  };

  const stopTimer = (): void => {
    if (timer) clearInterval(timer);
    timer = undefined;
  };

  /** 全部終わっていれば restart の合図を書いて終了を頼む。 */
  async function check(): Promise<void> {
    if (!state || state.phase !== "waiting" || !idle()) return;
    state.phase = "restarting";
    stopTimer();
    const { to, spec } = state;
    try {
      await writeUpdateFile(workspace, { state: "restart", to, spec });
    } catch (e) {
      const error = `update.json を書けない: ${e instanceof Error ? e.message : String(e)}`;
      log(`更新中止: ${error}`);
      lastFailure = { to, ok: false, error, at: now().toISOString() };
      state = null;
      return;
    }
    log(`更新のため終了: ${serverVersion} -> ${to} spec=${spec}`);
    deps.requestExit("update");
  }

  function startWaiting(to: string, spec: string): void {
    state = { phase: "waiting", to, spec };
    lastFailure = null;
    timer = setInterval(() => void check(), pollMs);
    timer.unref?.();
  }

  const result = (st: UpdateResultReply["state"], to: string): UpdateResultReply => ({
    bantou: PROTOCOL_VERSION,
    type: "update_result",
    ok: true,
    state: st,
    from: serverVersion,
    to,
    running: deps.running(),
  });

  async function request(version: string): Promise<UpdateResultReply> {
    if (!isValidServerVersion(version)) {
      throw new UpdateError("invalid_version", `版が不正: ${version}`, false);
    }
    if (state) {
      if (state.to === version) return result(state.phase, version);
      throw new UpdateError(
        "update_conflict",
        `別の更新が進行中（${serverVersion} -> ${state.to}）。完了後に ${version} を指示する`,
        true,
      );
    }
    if (version === serverVersion) return result("current", version);
    if (fetching) {
      if (fetching.to !== version) {
        throw new UpdateError("update_conflict", `別の版 ${fetching.to} を取得中。完了後に ${version} を指示する`, true);
      }
      await fetching.p.catch(() => undefined);
      const joined = currentState();
      if (joined && joined.to === version) return result(joined.phase, version);
      throw new UpdateError("update_failed", `版 ${version} の取得に失敗`, false);
    }
    const spec = buildSpec(deps.specTemplate, version);
    log(`更新指示: ${serverVersion} -> ${version} spec=${spec}`);
    const p = fetchFn(spec, version);
    fetching = { to: version, p: p.then(() => undefined) };
    fetching.p.catch(() => undefined);
    try {
      await p;
    } catch (e) {
      const err = e instanceof UpdateError ? e : new UpdateError("update_failed", e instanceof Error ? e.message : String(e), false);
      lastFailure = { to: version, ok: false, error: err.message, at: now().toISOString() };
      log(`更新失敗: ${err.message}`);
      throw err;
    } finally {
      fetching = null;
    }
    log(`取得確認 OK: ${spec} -> ${version}`);
    startWaiting(version, spec);
    const r = deps.running();
    log(`更新待機: caps=${r.caps} workers=${r.workers} reports=${r.reports}`);
    await check();
    const after = currentState();
    if (!after) throw new UpdateError("update_failed", lastFailure?.error ?? "更新を開始できない", false);
    return result(after.phase, version);
  }

  return {
    isUpdating: () => state !== null,
    progress,
    hello: () => ({
      bantou: PROTOCOL_VERSION,
      type: "hello_result",
      ok: true,
      server_version: serverVersion,
      protocol_version: MESSENGER_PROTOCOL.version,
      update: progress(),
      last_update: lastFailure,
    }),
    request,
    loadLastFailure: async () => {
      const f = await readUpdateFile(workspace);
      if (f?.state === "failed") lastFailure = { to: f.to, ok: false, error: f.error, at: f.at };
    },
    close: stopTimer,
  };
}
