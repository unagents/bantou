import type { Db } from "./db";
import type { ErrorNote, WorkerState } from "./worker";

/** status tool の出力。件数と時刻と error の要旨だけ（記憶・event の本文は返さない） */
export interface StatusResult {
  agentId: string;
  memories: {
    total: number;
    byStatus: Record<string, number>;
    /** 現在の embedding model で埋め込み済み（recall の対象） */
    embedded: number;
    /** 埋め込み待ち（recall にまだ出ない） */
    pendingEmbedding: number;
    /** pendingEmbedding のうち、失敗して再試行を待っている件数 */
    embeddingRetryWait: number;
    oldestPendingCreatedAt: string | null;
    newestPendingCreatedAt: string | null;
  };
  events: {
    total: number;
    /** 抽出待ち（dead-letter を除く） */
    unprocessed: number;
    deadLetter: number;
    oldestUnprocessedAt: string | null;
  };
  /** 最後に抽出が通った event の処理時刻 */
  lastExtractedAt: string | null;
  /** 最後に埋め込みが通った時刻 */
  lastEmbeddedAt: string | null;
  lastErrors: {
    /** DB に残っている直近の失敗（未処理の event / 埋め込み待ちの item のもの） */
    extract: { message: string; deadLetterAt: string | null } | null;
    embed: { message: string; at: string | null; attempts: number } | null;
    /** この process の worker が直近に記録した失敗（再起動で消える） */
    workerExtract: ErrorNote | null;
    workerEmbed: ErrorNote | null;
    workerRun: ErrorNote | null;
  };
  worker: { running: boolean; lastRunAt: string | null; lastRunMs: number | null };
  embedModel: string;
}

const iso = (v: Date | string | null | undefined): string | null => (v ? new Date(v).toISOString() : null);

/**
 * agent 1 つ分の状態。全て認証済み agent の行だけを数える（SQL の条件 + RLS）。
 * worker の欄（実行中か・最後の run）は service 全体の値で、agent の data を含まない。
 */
export async function buildStatus(db: Db, agentId: string, embedModel: string, worker: WorkerState): Promise<StatusResult> {
  return db.withAgent(agentId, async (q) => {
    const items = (await q.query<{
      total: number; embedded: number; pending: number; retry_wait: number;
      last_embedded_at: Date | string | null; oldest_pending: Date | string | null; newest_pending: Date | string | null;
    }>(
      `SELECT count(*)::int AS total,
              (count(*) FILTER (WHERE embedding IS NOT NULL AND embed_model = $2))::int AS embedded,
              (count(*) FILTER (WHERE embedding IS NULL OR embed_model IS DISTINCT FROM $2))::int AS pending,
              (count(*) FILTER (WHERE (embedding IS NULL OR embed_model IS DISTINCT FROM $2) AND embed_failed_at IS NOT NULL))::int AS retry_wait,
              max(embedded_at) AS last_embedded_at,
              min(created_at) FILTER (WHERE embedding IS NULL OR embed_model IS DISTINCT FROM $2) AS oldest_pending,
              max(created_at) FILTER (WHERE embedding IS NULL OR embed_model IS DISTINCT FROM $2) AS newest_pending
         FROM memory_items WHERE agent_id = $1`,
      [agentId, embedModel],
    )).rows[0]!;
    const byStatus = (await q.query<{ status: string; n: number }>(
      "SELECT status, count(*)::int AS n FROM memory_items WHERE agent_id = $1 GROUP BY status ORDER BY status",
      [agentId],
    )).rows;
    const events = (await q.query<{
      total: number; unprocessed: number; dead_letter: number;
      last_extracted_at: Date | string | null; oldest_unprocessed: Date | string | null;
    }>(
      `SELECT count(*)::int AS total,
              (count(*) FILTER (WHERE processed_at IS NULL AND failed_at IS NULL))::int AS unprocessed,
              (count(*) FILTER (WHERE failed_at IS NOT NULL))::int AS dead_letter,
              max(processed_at) AS last_extracted_at,
              min(recorded_at) FILTER (WHERE processed_at IS NULL AND failed_at IS NULL) AS oldest_unprocessed
         FROM memory_events WHERE agent_id = $1`,
      [agentId],
    )).rows[0]!;
    const embedErr = (await q.query<{ embed_error: string | null; embed_failed_at: Date | string | null; embed_attempts: number }>(
      `SELECT embed_error, embed_failed_at, embed_attempts FROM memory_items
        WHERE agent_id = $1 AND embed_failed_at IS NOT NULL AND (embedding IS NULL OR embed_model IS DISTINCT FROM $2)
        ORDER BY embed_failed_at DESC LIMIT 1`,
      [agentId, embedModel],
    )).rows[0];
    const extractErr = (await q.query<{ last_error: string; failed_at: Date | string | null }>(
      `SELECT last_error, failed_at FROM memory_events
        WHERE agent_id = $1 AND last_error IS NOT NULL AND processed_at IS NULL
        ORDER BY failed_at DESC NULLS LAST, recorded_at DESC LIMIT 1`,
      [agentId],
    )).rows[0];
    const w = worker.agents.get(agentId);
    return {
      agentId,
      memories: {
        total: Number(items.total),
        byStatus: Object.fromEntries(byStatus.map((r) => [r.status, Number(r.n)])),
        embedded: Number(items.embedded),
        pendingEmbedding: Number(items.pending),
        embeddingRetryWait: Number(items.retry_wait),
        oldestPendingCreatedAt: iso(items.oldest_pending),
        newestPendingCreatedAt: iso(items.newest_pending),
      },
      events: {
        total: Number(events.total),
        unprocessed: Number(events.unprocessed),
        deadLetter: Number(events.dead_letter),
        oldestUnprocessedAt: iso(events.oldest_unprocessed),
      },
      lastExtractedAt: iso(events.last_extracted_at),
      lastEmbeddedAt: iso(items.last_embedded_at),
      lastErrors: {
        extract: extractErr ? { message: extractErr.last_error.slice(0, 200), deadLetterAt: iso(extractErr.failed_at) } : null,
        embed: embedErr ? { message: (embedErr.embed_error ?? "").slice(0, 200), at: iso(embedErr.embed_failed_at), attempts: Number(embedErr.embed_attempts) } : null,
        workerExtract: w?.extractError ?? null,
        workerEmbed: w?.embedError ?? null,
        workerRun: worker.lastRunError ?? null,
      },
      worker: { running: worker.running, lastRunAt: worker.lastRunAt ?? null, lastRunMs: worker.lastRunMs ?? null },
      embedModel,
    };
  });
}
