import type { Db } from "./db";
import { embedBacklog, errorSummary, type EmbedGate, type Embedder, type EmbedRunOptions, type EmbedRunSummary } from "./embed";
import { extractAll, type ChatClient, type ExtractSummary } from "./extract";

/** memory:extract の 1 回の実行（抽出 → 埋め込み）と、その結果の記録（log と状態の口のため。process の中だけに持つ） */
export interface WorkerDeps {
  db: Db;
  embedder: Embedder;
  chat: ChatClient;
  extractBatch: number;
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

export interface WorkerState {
  running: boolean;
  /** 最後に終わった run の開始時刻と所要時間 */
  lastRunAt?: string;
  lastRunMs?: number;
  /** run 全体の失敗（agent の一覧が取れない等） */
  lastRunError?: ErrorNote;
  agents: Map<string, AgentWorkerState>;
}

export interface CycleResult {
  skipped?: true;
  results: ExtractSummary[];
  errors: { agentId: string; message: string }[];
  embed?: EmbedRunSummary;
  embedErrors: { agentId: string; message: string }[];
}

export type LogFn = (line: string) => void;

const state: WorkerState = { running: false, agents: new Map() };

export function workerState(): WorkerState {
  return state;
}

/** test 用 */
export function resetWorkerState(): void {
  state.running = false;
  state.lastRunAt = undefined;
  state.lastRunMs = undefined;
  state.lastRunError = undefined;
  state.agents.clear();
}

const agentState = (id: string): AgentWorkerState => {
  let s = state.agents.get(id);
  if (!s) state.agents.set(id, (s = {}));
  return s;
};

/**
 * 抽出 → 埋め込みを 1 回。
 *  - 同じ process の中で重ならない（実行中なら何もせず戻る。Nitro の runTask も同名 task の重複実行をまとめる）
 *  - log は件数が動いた時と error の時だけ（何も無い run は 1 行も出さない）。本文・token は出さない
 */
export async function runCycle(deps: WorkerDeps, log: { info: LogFn; warn: LogFn } = { info: (l) => console.log(l), warn: (l) => console.warn(l) }): Promise<CycleResult> {
  if (state.running) return { skipped: true, results: [], errors: [], embedErrors: [] };
  state.running = true;
  const started = Date.now();
  const at = () => new Date().toISOString();
  try {
    const { results, errors } = await extractAll(deps.db, { chat: deps.chat, batchSize: deps.extractBatch });
    for (const r of results) {
      if (r.events === 0) continue;
      log.info(
        `[memory] extract: agent=${r.agentId} events=${r.events} accepted=${r.accepted} rejected=${r.rejected} downgraded=${r.downgraded} retried=${r.retried} dead-letter=${r.failed} systemic=${r.systemic} aborted=${r.aborted}`,
      );
      if (r.systemic > 0) agentState(r.agentId).extractError = { at: at(), message: `chatp: all ${r.systemic} events failed (no batch passed); will retry` };
    }
    for (const e of errors) {
      const message = errorSummary(e.message);
      agentState(e.agentId).extractError = { at: at(), message };
      log.warn(`[memory] extract error: agent=${e.agentId} ${message}`);
    }

    const agents = (await deps.db.query<{ id: string }>("SELECT id FROM agents ORDER BY id")).rows.map((r) => r.id);
    const embed = await embedBacklog(deps.db, deps.embedder, agents, { ...deps.embed, gate: deps.gate });
    const embedErrors: { agentId: string; message: string }[] = [];
    for (const s of embed.agents) {
      if (s.embedded > 0 || s.failed > 0 || s.errors.length > 0) {
        log.info(`[memory] embed: agent=${s.agentId} embedded=${s.embedded} failed=${s.failed} remaining=${s.remaining} retry-wait=${s.retryWait} run=${embed.stopped}`);
      }
      for (const m of s.errors) {
        embedErrors.push({ agentId: s.agentId, message: m });
        log.warn(`[memory] embed error: agent=${s.agentId} ${m}`);
      }
      if (s.errors.length > 0) agentState(s.agentId).embedError = { at: at(), message: s.errors[s.errors.length - 1]! };
    }
    return { results, errors, embed, embedErrors };
  } catch (e) {
    const message = errorSummary(e);
    state.lastRunError = { at: at(), message };
    log.warn(`[memory] run error: ${message}`);
    throw e;
  } finally {
    state.running = false;
    state.lastRunAt = new Date(started).toISOString();
    state.lastRunMs = Date.now() - started;
  }
}
