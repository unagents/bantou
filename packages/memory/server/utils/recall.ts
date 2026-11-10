import { z } from "zod";
import type { Db } from "./db";
import type { Embedder } from "./embed";
import { toVectorLiteral, checkVectors } from "./embed";

export class ForbiddenError extends Error {}
export class NotFoundError extends Error {}

const iso = z.iso.datetime({ offset: true });

/** §8.1 の MemoryRecallRequest。memoryTypes 省略時は 4 種全て */
export const recallShape = {
  query: z.string().min(1).max(2000),
  memoryTypes: z.array(z.enum(["semantic", "episodic", "relational", "procedural"])).max(4).optional(),
  scope: z
    .object({
      projectIds: z.array(z.string().max(128)).max(50).optional(),
      agentIds: z.array(z.string().max(128)).max(10).optional().describe("自分の agent ID のみ指定可。他 agent は拒否"),
      userId: z.string().max(128).optional().describe("Phase 1 では未使用"),
    })
    .optional(),
  temporal: z.object({ validAt: iso.optional(), from: iso.optional(), to: iso.optional() }).optional(),
  includeInferred: z.boolean().optional(),
  limit: z.number().int().min(1).max(50).optional(),
};
export const recallSchema = z.object(recallShape);
export type RecallRequest = z.infer<typeof recallSchema>;

/** §8.2 の MemoryRecallResult */
export interface RecallResult {
  id: string;
  content: string;
  memoryType: string;
  status: "confirmed" | "verified" | "inferred" | "superseded";
  sourceEventIds: string[];
  validFrom?: string;
  validUntil?: string;
  confidence?: number;
  relevance: number;
}

interface ItemRow {
  id: string;
  content: string;
  memory_type: string;
  status: RecallResult["status"];
  source_event_ids: string[];
  valid_from: Date | string | null;
  valid_until: Date | string | null;
  confidence: number | null;
  relevance: number;
}

const iso8601 = (v: Date | string) => new Date(v).toISOString();

function toResult(r: ItemRow): RecallResult {
  const out: RecallResult = {
    id: r.id,
    content: r.content,
    memoryType: r.memory_type,
    status: r.status,
    sourceEventIds: r.source_event_ids,
    relevance: Number(r.relevance),
  };
  if (r.valid_from) out.validFrom = iso8601(r.valid_from);
  if (r.valid_until) out.validUntil = iso8601(r.valid_until);
  if (r.confidence !== null && r.confidence !== undefined) out.confidence = Number(r.confidence);
  return out;
}

/**
 * 近傍検索（cosine）+ status / 期間の絞り込み。
 *  - 既定の status は confirmed / verified。includeInferred で inferred も含める
 *  - superseded は temporal を指定した時だけ含める（過去時点の状態を引くため）
 *  - 他 agent の private は見えない（SQL の条件 + RLS）。scope.agentIds に他 agent を入れたら拒否
 *  - embed_model が現在の model と一致する item だけが対象（model 変更後の次元・空間の不整合を避ける）
 */
export async function recall(db: Db, embedder: Embedder, agentId: string, raw: unknown): Promise<RecallResult[]> {
  const req = recallSchema.parse(raw);
  for (const a of req.scope?.agentIds ?? []) {
    if (a !== agentId) throw new ForbiddenError("他の agent の記憶は読めない");
  }
  const [vec] = checkVectors(await embedder.embed([req.query]), 1, embedder.dim);
  const types = req.memoryTypes?.length ? req.memoryTypes : ["semantic", "episodic", "relational", "procedural"];
  const t = req.temporal;
  const temporal = !!(t?.validAt || t?.from || t?.to);
  const statuses = ["confirmed", "verified"];
  if (req.includeInferred) statuses.push("inferred");
  if (temporal) statuses.push("superseded");
  const limit = req.limit ?? 10;

  const rows = await db.withAgent(agentId, async (q) =>
    (await q.query<ItemRow>(
      `SELECT i.id, i.content, i.memory_type, i.status, i.valid_from, i.valid_until, i.confidence,
              1 - (i.embedding <=> $1::vector) AS relevance,
              COALESCE((SELECT array_agg(s.event_id ORDER BY s.event_id) FROM memory_sources s WHERE s.item_id = i.id), '{}') AS source_event_ids
         FROM memory_items i
        WHERE (i.agent_id = $2 OR i.scope IN ('shared','organizational'))
          AND i.embedding IS NOT NULL AND i.embed_model = $3
          AND i.memory_type = ANY($4::text[])
          AND i.status = ANY($5::text[])
          AND ($6::text[] IS NULL OR i.project_id = ANY($6::text[]))
          AND ($7::timestamptz IS NULL OR ((i.valid_from IS NULL OR i.valid_from <= $7::timestamptz) AND (i.valid_until IS NULL OR i.valid_until > $7::timestamptz)))
          AND ($8::timestamptz IS NULL OR i.valid_until IS NULL OR i.valid_until > $8::timestamptz)
          AND ($9::timestamptz IS NULL OR i.valid_from IS NULL OR i.valid_from <= $9::timestamptz)
        ORDER BY i.embedding <=> $1::vector
        LIMIT $10`,
      [
        toVectorLiteral(vec!), agentId, embedder.model, types, statuses,
        req.scope?.projectIds?.length ? req.scope.projectIds : null,
        t?.validAt ?? null, t?.from ?? null, t?.to ?? null, limit,
      ],
    )).rows,
  );
  return rows.map(toResult);
}

/** 新 item で旧 item を置き換える（履歴は残す）。revise tool は Phase 1 に無いので内部 API */
export async function supersede(db: Db, agentId: string, oldId: string, newId: string): Promise<void> {
  await db.withAgent(agentId, async (q) => {
    const r = await q.query(
      `UPDATE memory_items o SET status = 'superseded', superseded_by = n.id,
              valid_until = COALESCE(o.valid_until, n.valid_from, now()), updated_at = now()
         FROM memory_items n
        WHERE o.id = $1 AND n.id = $2 AND o.agent_id = $3 AND n.agent_id = $3 AND o.id <> n.id
        RETURNING o.id`,
      [oldId, newId, agentId],
    );
    if (r.rows.length === 0) throw new NotFoundError("対象の item が無い");
  });
}

// ---- context ----

export const contextShape = {
  agentId: z.string().max(128).optional().describe("省略可。指定する場合は自分の agent ID のみ"),
};

export interface ContextResult {
  agentId: string;
  policies: RecallResult[];
  recentDecisions: RecallResult[];
  openQuestions: { eventId: string; taskId: string | null; at: string; body: string }[];
  activeTasks: { taskId: string; remoteId: string | null; at: string; body: string }[];
}

/**
 * 判断用の要約。LLM は使わず、保存済みの確定情報から決定論的に作る。
 *  - policies: confirmed の semantic / procedural（新しい順 10）
 *  - recentDecisions: confirmed の episodic（新しい順 10）
 *  - openQuestions: kind=report で、同じ task_id の後続 reply が無いもの
 *  - activeTasks: kind=task で、同じ task_id の後続 result が無いもの
 */
export async function buildContext(db: Db, agentId: string, raw: unknown): Promise<ContextResult> {
  const { agentId: asked } = z.object(contextShape).parse(raw ?? {});
  if (asked !== undefined && asked !== agentId) throw new ForbiddenError("他の agent の context は読めない");
  return db.withAgent(agentId, async (q) => {
    const items = async (types: string[]) =>
      (await q.query<ItemRow>(
        `SELECT i.id, i.content, i.memory_type, i.status, i.valid_from, i.valid_until, i.confidence, 1.0 AS relevance,
                COALESCE((SELECT array_agg(s.event_id ORDER BY s.event_id) FROM memory_sources s WHERE s.item_id = i.id), '{}') AS source_event_ids
           FROM memory_items i
          WHERE i.agent_id = $1 AND i.status = 'confirmed' AND i.memory_type = ANY($2::text[])
          ORDER BY i.created_at DESC, i.id LIMIT 10`,
        [agentId, types],
      )).rows.map(toResult);
    const questions = await q.query<{ event_id: string; task_id: string | null; at: Date; body: string }>(
      `SELECT e.event_id, e.task_id, e.at, e.body FROM memory_events e
        WHERE e.agent_id = $1 AND e.kind = 'report'
          AND NOT EXISTS (SELECT 1 FROM memory_events r WHERE r.agent_id = e.agent_id AND r.kind = 'reply' AND r.task_id IS NOT DISTINCT FROM e.task_id AND r.task_id IS NOT NULL AND r.at > e.at)
        ORDER BY e.at DESC LIMIT 10`,
      [agentId],
    );
    const tasks = await q.query<{ task_id: string; remote_id: string | null; at: Date; body: string }>(
      `SELECT e.task_id, e.remote_id, e.at, e.body FROM memory_events e
        WHERE e.agent_id = $1 AND e.kind = 'task' AND e.task_id IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM memory_events r WHERE r.agent_id = e.agent_id AND r.kind = 'result' AND r.task_id = e.task_id AND r.at > e.at)
        ORDER BY e.at DESC LIMIT 10`,
      [agentId],
    );
    return {
      agentId,
      policies: await items(["semantic", "procedural"]),
      recentDecisions: await items(["episodic"]),
      openQuestions: questions.rows.map((r) => ({ eventId: r.event_id, taskId: r.task_id, at: iso8601(r.at), body: r.body })),
      activeTasks: tasks.rows.map((r) => ({ taskId: r.task_id, remoteId: r.remote_id, at: iso8601(r.at), body: r.body })),
    };
  });
}

// ---- explain ----

export const explainShape = { id: z.string().uuid() };

export interface ExplainResult {
  item: RecallResult & { scope: string; supersededBy?: string };
  sources: { eventId: string; kind: string; at: string; sender: { session?: string; capId?: string; workerId?: string }; taskId?: string; remoteId?: string; body: string }[];
  verification: { status: string; hasUserPromptSource: boolean; rule: string };
}

/** 出典 event と検証状態。見えない item（他 agent の private）は存在しないものとして扱う */
export async function explain(db: Db, agentId: string, raw: unknown): Promise<ExplainResult> {
  const { id } = z.object(explainShape).parse(raw);
  return db.withAgent(agentId, async (q) => {
    const it = await q.query<ItemRow & { scope: string; superseded_by: string | null }>(
      `SELECT i.id, i.content, i.memory_type, i.status, i.valid_from, i.valid_until, i.confidence, 1.0 AS relevance, i.scope, i.superseded_by,
              COALESCE((SELECT array_agg(s.event_id ORDER BY s.event_id) FROM memory_sources s WHERE s.item_id = i.id), '{}') AS source_event_ids
         FROM memory_items i WHERE i.id = $1 AND (i.agent_id = $2 OR i.scope IN ('shared','organizational'))`,
      [id, agentId],
    );
    const row = it.rows[0];
    if (!row) throw new NotFoundError("item が無い");
    const ev = await q.query<{
      event_id: string; kind: string; at: Date; body: string; task_id: string | null; remote_id: string | null;
      sender_session: string | null; sender_cap_id: string | null; sender_worker_id: string | null;
    }>(
      `SELECT e.event_id, e.kind, e.at, e.body, e.task_id, e.remote_id, e.sender_session, e.sender_cap_id, e.sender_worker_id
         FROM memory_sources s JOIN memory_events e ON e.agent_id = s.agent_id AND e.event_id = s.event_id
        WHERE s.item_id = $1 ORDER BY e.at, e.event_id`,
      [id],
    );
    const sources = ev.rows.map((e) => ({
      eventId: e.event_id,
      kind: e.kind,
      at: iso8601(e.at),
      sender: {
        ...(e.sender_session ? { session: e.sender_session } : {}),
        ...(e.sender_cap_id ? { capId: e.sender_cap_id } : {}),
        ...(e.sender_worker_id ? { workerId: e.sender_worker_id } : {}),
      },
      ...(e.task_id ? { taskId: e.task_id } : {}),
      ...(e.remote_id ? { remoteId: e.remote_id } : {}),
      body: e.body,
    }));
    const hasUser = sources.some((s) => s.kind === "user_prompt");
    return {
      item: { ...toResult(row), scope: row.scope, ...(row.superseded_by ? { supersededBy: row.superseded_by } : {}) },
      sources,
      verification: {
        status: row.status,
        hasUserPromptSource: hasUser,
        rule: "confirmed は kind=user_prompt の出典を持つ時だけ。それ以外は inferred",
      },
    };
  });
}
