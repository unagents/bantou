import { getRuntime } from "./runtime";
import { runEmbedCycle, runExtractCycle, runTaskSafely, type CycleOptions, type EmbedCycleResult, type ExtractCycleResult, type WorkerLog } from "./worker";

// task（server/tasks/memory/*.ts）の中身。task の file は Nitro の実行時にしか読み込めないので、配線はここに置いて test する。
// どちらも失敗を外へ throw しない（runTaskSafely。throw すると Nitro の scheduler が毎分 error を丸ごと出力する）

/** memory:embed の 1 回。recall の query と同じ門（rt.gate）を渡す（渡さないと query 優先が効かない） */
export function runEmbedTask(log?: WorkerLog, opts?: CycleOptions): Promise<EmbedCycleResult | { error: string }> {
  return runTaskSafely(
    async () => {
      const rt = await getRuntime();
      return runEmbedCycle({ db: rt.db, embedder: rt.embedder, embed: rt.embed, gate: rt.gate }, log, opts);
    },
    log,
    opts,
  );
}

/** memory:extract の 1 回 */
export function runExtractTask(log?: WorkerLog, opts?: CycleOptions): Promise<ExtractCycleResult | { error: string }> {
  return runTaskSafely(
    async () => {
      const rt = await getRuntime();
      return runExtractCycle({ db: rt.db, chat: rt.chat, extractBatch: rt.extractBatch }, log, opts);
    },
    log,
    opts,
  );
}
