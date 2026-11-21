import { errorSummary } from "./embed";
import { getRuntime } from "./runtime";
import { syncAll, type SyncAllResult } from "./graphiti-sync";
import type { Db } from "./db";
import type { GraphitiClient } from "./graphiti";
import { gist, type WorkerLog } from "./worker";

// task memory:graphiti の中身（Outbox → Graphiti）。抽出・埋め込みとは別の task で、互いを待たない。
// log は件数が動いた時と error の時だけ。同じ要旨の error は初回だけ出し、解消した時に 1 行出す。本文・token・URL は出さない。
// task は失敗を外へ throw しない（Nitro の scheduler が毎分 error を丸ごと出力するため）。

export interface GraphitiCycleDeps {
  db: Db;
  graphiti: GraphitiClient;
  topics: string[];
}
export type GraphitiCycleResult = (SyncAllResult & { skipped?: undefined }) | { skipped: true; results: []; errors: [] } | { error: string };

let running = false;
let lastError: string | undefined;

/** test 用 */
export function resetGraphitiCycleState(): void {
  running = false;
  lastError = undefined;
}

const defaultLog: WorkerLog = { info: (l) => console.log(l), warn: (l) => console.warn(l) };

export async function runGraphitiCycle(deps: GraphitiCycleDeps, log: WorkerLog = defaultLog): Promise<GraphitiCycleResult> {
  if (running) return { skipped: true, results: [], errors: [] };
  running = true;
  try {
    const r = await syncAll(deps.db, { graphiti: deps.graphiti, topics: deps.topics });
    for (const s of r.results) {
      if (s.confirmed + s.sent + s.retried + s.failed > 0) {
        log.info(`[memory] graphiti: agent=${s.agentId} confirmed=${s.confirmed} sent=${s.sent} waiting=${s.waiting} retried=${s.retried} dead-letter=${s.failed}`);
      }
    }
    const first = r.errors[0];
    if (first) {
      const g = gist(errorSummary(first.message));
      if (g !== lastError) {
        lastError = g;
        log.warn(`[memory] graphiti error: agent=${first.agentId} ${errorSummary(first.message)}${r.errors.length > 1 ? ` (+${r.errors.length - 1} agents)` : ""}`);
      }
    } else if (lastError) {
      lastError = undefined;
      log.info("[memory] graphiti recovered");
    }
    return r;
  } catch (e) {
    const message = errorSummary(e);
    const g = gist(message);
    if (g !== lastError) {
      lastError = g;
      log.warn(`[memory] graphiti run error: ${message}`);
    }
    return { error: message };
  } finally {
    running = false;
  }
}

/** memory:graphiti の 1 回。GRAPHITI_MCP_URL が無ければ何もしない（Outbox は積むだけのまま） */
export async function runGraphitiTask(log?: WorkerLog): Promise<GraphitiCycleResult | { disabled: true }> {
  try {
    const rt = await getRuntime();
    if (!rt.graphiti) return { disabled: true };
    return await runGraphitiCycle({ db: rt.db, graphiti: rt.graphiti.client, topics: rt.graphiti.topics }, log);
  } catch (e) {
    const message = errorSummary(e);
    const g = gist(message);
    if (g !== lastError) {
      lastError = g;
      (log ?? defaultLog).warn(`[memory] graphiti run error: ${message}`);
    }
    return { error: message };
  }
}
