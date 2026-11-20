import { setStatementTimeout, type Db } from "./db";
import { EMBED_SQL_TIMEOUT_MS, createEmbedState, embedBacklog, errorSummary, publicErrorSummary, type EmbedGate, type Embedder, type EmbedRunOptions, type EmbedRunSummary, type EmbedState } from "./embed";
import { extractAll, type ChatClient, type ExtractSummary } from "./extract";

/**
 * 抽出（memory:extract）と埋め込み（memory:embed）の 1 回の実行と、その結果の記録（log と状態の口のため。process の中だけに持つ）。
 * 2 つは別の task で、互いを待たない（chatp が遅い・無応答の間も、埋め込みは毎分進む）。
 */
export interface ExtractCycleDeps {
  db: Db;
  chat: ChatClient;
  extractBatch: number;
}

export interface EmbedCycleDeps {
  db: Db;
  embedder: Embedder;
  embed: Pick<EmbedRunOptions, "batchSize" | "maxRunMs">;
  gate?: EmbedGate;
}

export interface ErrorNote {
  at: string;
  message: string;
}

export interface AgentWorkerState {
  extractError?: ErrorNote;
  embedError?: ErrorNote;
}

export interface TaskRunState {
  running: boolean;
  /** 最後に終わった run の開始時刻と所要時間 */
  lastRunAt?: string;
  lastRunMs?: number;
  /** run 全体の失敗（agent の一覧が取れない等）。次に成功した run で消える。status で agent に見えるので、種類 + error の code だけ（接続先を含めない） */
  lastRunError?: ErrorNote;
}

export interface WorkerState {
  extract: TaskRunState;
  embed: TaskRunState;
  /** agent ごとの直近の失敗。その agent の処理が次に成功した時に消える */
  agents: Map<string, AgentWorkerState>;
}

export interface ExtractCycleResult {
  skipped?: true;
  results: ExtractSummary[];
  errors: { agentId: string; message: string }[];
}

export interface EmbedCycleResult {
  skipped?: true;
  embed?: EmbedRunSummary;
  embedErrors: { agentId: string; message: string }[];
}

/** run の中の失敗（log と状態への記録は済んでいる） */
export class CycleError extends Error {}

export type LogFn = (line: string) => void;
export interface WorkerLog {
  info: LogFn;
  warn: LogFn;
}
export interface CycleOptions {
  /** 同じ要旨の error を log に出し直す間隔（ミリ秒） */
  logRepeatMs?: number;
}

/** 同じ要旨の error が続く時に log へ出し直す間隔の既定（30 分） */
export const LOG_REPEAT_MS = 30 * 60_000;

const state: WorkerState = { extract: { running: false }, embed: { running: false }, agents: new Map() };
let embedState: EmbedState = createEmbedState();
/** error の log の間引き。key = 種類 | agent | 要旨（毎回変わる値を潰したもの） */
const logged = new Map<string, { at: number; suppressed: number }>();

export function workerState(): WorkerState {
  return state;
}

/** test 用 */
export function resetWorkerState(): void {
  state.extract = { running: false };
  state.embed = { running: false };
  state.agents.clear();
  embedState = createEmbedState();
  logged.clear();
}

const defaultLog: WorkerLog = { info: (l) => console.log(l), warn: (l) => console.warn(l) };
const at = () => new Date().toISOString();

const agentState = (id: string): AgentWorkerState => {
  let s = state.agents.get(id);
  if (!s) state.agents.set(id, (s = {}));
  return s;
};
const clearAgentError = (id: string, key: keyof AgentWorkerState): void => {
  const s = state.agents.get(id);
  if (!s) return;
  delete s[key];
  if (!s.extractError && !s.embedError) state.agents.delete(id);
};

/**
 * 毎回変わる値（item の ID・件数・所要時間など）を潰した要旨。それだけが違う error を同じものとして数える。
 * HTTP の status と error の code（`HTTP 500` / `code 57014`）は潰さない（違う error として出す）
 */
export const gist = (m: string) =>
  m
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "#")
    .replace(/\b(?:HTTP|status|code)[ =:]+\w+|\d+/g, (x) => (/^\d+$/.test(x) ? "#" : x));

/**
 * 同じ key の行は、初回と repeatMs ごとにだけ出す。出す時は、その間に省いた回数を付ける。戻り値は「出すか」と付け足す文言
 */
function throttle(key: string, repeatMs: number): { emit: boolean; suffix: string } {
  const t = performance.now();
  const e = logged.get(key);
  if (e && t - e.at < repeatMs) {
    e.suppressed++;
    return { emit: false, suffix: "" };
  }
  // 際限なく増やさない（key は agent × error の種類。通常は少数）
  if (!e && logged.size >= 2000) logged.clear();
  logged.set(key, { at: t, suppressed: 0 });
  return { emit: true, suffix: e && e.suppressed > 0 ? ` (same error suppressed ${e.suppressed} times)` : "" };
}
/** prefix で始まる key を全て消す。1 つでもあれば true（= error が続いていて、今解消した） */
function clearLogged(prefix: string): boolean {
  let had = false;
  for (const k of [...logged.keys()]) {
    if (k.startsWith(prefix)) {
      logged.delete(k);
      had = true;
    }
  }
  return had;
}

/**
 * 1 回の run の枠: process の中で重ならない（実行中なら何もせず戻る。Nitro の runTask も同名 task の重複実行をまとめる）。
 * run 全体の失敗は記録して log に出し（同じ要旨は間引く）、成功した run で消す。
 * log には運用者が原因を追える要旨を出し、status と task の戻り値には種類 + error の code だけを残す（agent に接続先を見せない）
 */
async function runOnce<T>(name: "extract" | "embed", skipped: T, log: WorkerLog, repeatMs: number, fn: () => Promise<T>): Promise<T> {
  const st = state[name];
  if (st.running) return skipped;
  st.running = true;
  const startedAt = at();
  const started = performance.now();
  try {
    const r = await fn();
    if (st.lastRunError) {
      st.lastRunError = undefined;
      clearLogged(`${name}-run|`);
      log.info(`[memory] ${name} run recovered`);
    }
    return r;
  } catch (e) {
    const detail = errorSummary(e);
    const message = `${name} run failed: ${publicErrorSummary(e)}`;
    st.lastRunError = { at: at(), message };
    const t = throttle(`${name}-run||${gist(detail)}`, repeatMs);
    if (t.emit) log.warn(`[memory] ${name} run error: ${detail}${t.suffix}`);
    throw new CycleError(message);
  } finally {
    st.running = false;
    st.lastRunAt = startedAt;
    st.lastRunMs = Math.round(performance.now() - started);
  }
}

/**
 * 抽出を 1 回（全 agent）。
 * log は件数が動いた時と error の時だけ（何も無い run は 1 行も出さない）。同じ要旨の error が続く間は初回と一定の間隔ごとに絞り、解消した時に 1 行出す。本文・token は出さない
 */
export function runExtractCycle(deps: ExtractCycleDeps, log: WorkerLog = defaultLog, opts: CycleOptions = {}): Promise<ExtractCycleResult> {
  const repeatMs = opts.logRepeatMs ?? LOG_REPEAT_MS;
  return runOnce<ExtractCycleResult>("extract", { skipped: true, results: [], errors: [] }, log, repeatMs, async () => {
    const { results, errors } = await extractAll(deps.db, { chat: deps.chat, batchSize: deps.extractBatch });
    for (const r of results) {
      const prefix = `extract|${r.agentId}|`;
      const line = `[memory] extract: agent=${r.agentId} events=${r.events} accepted=${r.accepted} rejected=${r.rejected} downgraded=${r.downgraded} retried=${r.retried} dead-letter=${r.failed} systemic=${r.systemic} aborted=${r.aborted}`;
      if (r.systemic > 0) {
        // 通った batch が 1 つも無い（chatp 側の障害の疑い）。毎分同じ行が続くので間引く
        agentState(r.agentId).extractError = { at: at(), message: `chatp: all ${r.systemic} events failed (no batch passed); will retry` };
        const t = throttle(`${prefix}systemic`, repeatMs);
        if (t.emit) log.info(`${line}${t.suffix}`);
        continue;
      }
      clearAgentError(r.agentId, "extractError");
      if (clearLogged(prefix)) log.info(`[memory] extract recovered: agent=${r.agentId}`);
      if (r.events > 0) log.info(line);
    }
    for (const e of errors) {
      const message = errorSummary(e.message);
      agentState(e.agentId).extractError = { at: at(), message };
      const t = throttle(`extract|${e.agentId}|${gist(message)}`, repeatMs);
      if (t.emit) log.warn(`[memory] extract error: agent=${e.agentId} ${message}${t.suffix}`);
    }
    return { results, errors };
  });
}

/**
 * 埋め込みの消化を 1 回（全 agent。embedBacklog）。log の規則は runExtractCycle と同じ。
 * run をまたいで覚える事（始める agent・並びの枠・1 件ずつ送る事）は process の中に持つ
 */
export function runEmbedCycle(deps: EmbedCycleDeps, log: WorkerLog = defaultLog, opts: CycleOptions = {}): Promise<EmbedCycleResult> {
  const repeatMs = opts.logRepeatMs ?? LOG_REPEAT_MS;
  return runOnce<EmbedCycleResult>("embed", { skipped: true, embedErrors: [] }, log, repeatMs, async () => {
    // agent の一覧。他の SQL と同じく時間上限つき（agents に RLS は無いので、agent は設定しない）
    const agents = await deps.db.withAgent("", async (q) => {
      await setStatementTimeout(q, EMBED_SQL_TIMEOUT_MS);
      return (await q.query<{ id: string }>("SELECT id FROM agents ORDER BY id")).rows.map((r) => r.id);
    });
    const embed = await embedBacklog(deps.db, deps.embedder, agents, { ...deps.embed, gate: deps.gate, state: embedState });
    const embedErrors: { agentId: string; message: string }[] = [];
    for (const s of embed.agents) {
      const prefix = `embed|${s.agentId}|`;
      const warns: string[] = [];
      for (const m of s.errors) {
        embedErrors.push({ agentId: s.agentId, message: m });
        const t = throttle(`${prefix}${gist(m)}`, repeatMs);
        if (t.emit) warns.push(`[memory] embed error: agent=${s.agentId} ${m}${t.suffix}`);
      }
      if (s.errors.length > 0) {
        agentState(s.agentId).embedError = { at: at(), message: s.errors[s.errors.length - 1]! };
      } else if (s.embedded > 0 || s.remaining === 0) {
        // error 無しで進んだ（または待ちが無くなった）: 古い error を消し、続いていた error があれば解消を 1 行出す
        clearAgentError(s.agentId, "embedError");
        if (clearLogged(prefix)) log.info(`[memory] embed recovered: agent=${s.agentId}`);
      }
      // 1 件も通らず失敗だけの run（Ollama の障害中など）の件数の行は、error の行と一緒に間引く
      const failingOnly = s.embedded === 0 && s.errors.length > 0;
      if ((s.embedded > 0 || s.failed > 0) && (!failingOnly || warns.length > 0)) {
        log.info(`[memory] embed: agent=${s.agentId} embedded=${s.embedded} failed=${s.failed} remaining=${s.remaining} retry-wait=${s.retryWait} run=${embed.stopped}`);
      }
      for (const w of warns) log.warn(w);
    }
    return { embed, embedErrors };
  });
}

/**
 * task の入口で使う: 起動時の検査（DB 接続・role・次元）や run 全体の失敗を、task の外へ throw せずに要旨で返す。
 * throw すると Nitro の scheduler が毎分 error を丸ごと出力するため。起動時の失敗の log は 2 つの task で 1 行にまとめ、同じ要旨は間引く。
 * 起動時の検査を通った時（run が始まった時）に間引きの記録を消すので、直った後すぐの再発も log に出る
 */
export async function runTaskSafely<T>(start: () => Promise<T>, log: WorkerLog = defaultLog, opts: CycleOptions = {}): Promise<T | { error: string }> {
  const started = () => {
    if (clearLogged("start||")) log.info("[memory] run recovered");
  };
  try {
    const r = await start();
    started();
    return r;
  } catch (e) {
    const message = errorSummary(e);
    if (e instanceof CycleError) {
      // run の中の失敗（記録と log は済み）。起動時の検査は通っている
      started();
    } else {
      const t = throttle(`start||${gist(message)}`, opts.logRepeatMs ?? LOG_REPEAT_MS);
      if (t.emit) log.warn(`[memory] run error: ${message}${t.suffix}`);
    }
    return { error: message };
  }
}
