import type { Db } from "./db";
import { graphitiGroupId, GraphitiRejectedError, GraphitiUnavailableError, type AddMemoryRequest, type GraphitiClient } from "./graphiti";

// Outbox（outbox_events）の消費者: Graphiti への反映。設計は docs/design/memory-graphiti.md。
//  - 待ち → 送信済み（add_memory が受理された。Graphiti の queue は in-memory で、反映は後で非同期） → 反映済み（get_episodes で episode を確認）
//  - episode の突合は name（`item:<id>` / `event:<id>`）。add_memory の uuid は「既存 episode の更新」の意味で、新規の episode には使えない（実測。設計書の「実測」）。
//    Graphiti が付けた uuid は、反映を確認した時に outbox_events.episode_uuid へ控える（recall が fact の出典 episode から行を引く）
//  - 送信済みのまま確認できない行は、一定時間後に「待ち」へ戻して再送する
//  - 断られた（ErrorResponse）行は失敗回数を加算し、間隔を空けて再試行、上限で dead-letter（failed_at）
//  - Graphiti に届かない（接続失敗・timeout）時は失敗回数を加算せずに run を止める（障害中に dead-letter を作らない）

export const TOPIC_EVENT = "graphiti.episode";
export const TOPIC_ITEM = "graphiti.memory_item";
/** 既定で消費する topic（暫定。docs/design/memory-graphiti.md の未決 2）。他の topic の行は触らず、待ちのまま残る */
export const DEFAULT_TOPICS = [TOPIC_ITEM];

/** 失敗回数の上限。超えたら failed_at を立てる */
export const SYNC_MAX_ATTEMPTS = 5;
/** 1 agent が同時に持てる「送信済み・未確認」の行数（Graphiti の queue を溢れさせない） */
export const SYNC_IN_FLIGHT = 20;
/** 送信済みのまま確認できない行を再送する時間（分） */
export const SYNC_CONFIRM_TIMEOUT_MIN = 30;
/** episode に入れる本文の上限（抽出の prompt と同じ 4000 文字） */
export const SYNC_BODY_MAX = 4000;

export interface SyncDeps {
  graphiti: GraphitiClient;
  /** 消費する topic。省略時は DEFAULT_TOPICS */
  topics?: string[];
  inFlight?: number;
  confirmTimeoutMin?: number;
  now?: () => Date;
}

export interface SyncSummary {
  agentId: string;
  /** 反映を確認した行 */
  confirmed: number;
  /** この run で add_memory が受理された行 */
  sent: number;
  /** 断られた・確認できなくて失敗回数を加算した行 */
  retried: number;
  /** 上限に達して dead-letter にした行 */
  failed: number;
  /** 送信済みで確認待ちの行（この run の終わり） */
  waiting: number;
  /** Graphiti に届かず、この agent の run を止めた */
  unavailable: boolean;
}

interface OutboxRow {
  id: string;
  topic: string;
  idempotency_key: string;
  payload: { eventId?: string; itemId?: string };
  attempts: number;
  sent_at: Date | string | null;
}

const iso = (v: Date | string) => new Date(v).toISOString();
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);
const party = (s: string | null, c: string | null, w: string | null) => s ?? c ?? w ?? "unknown";

class Permanent extends Error {}

const rowKey = (row: OutboxRow): string => (row.topic === TOPIC_EVENT ? row.payload.eventId : row.payload.itemId) ?? row.idempotency_key;
/** Graphiti の episode の name。group（= agent）の中で一意 */
export const episodeName = (row: Pick<OutboxRow, "topic" | "payload" | "idempotency_key">): string => `${row.topic === TOPIC_EVENT ? "event" : "item"}:${rowKey(row as OutboxRow)}`;

/** Outbox の行から add_memory の引数を作る。出典の行が無い・未対応の scope は Permanent（再試行しても直らない） */
async function buildRequest(q: { query<T>(sql: string, p?: unknown[]): Promise<{ rows: T[] }> }, agentId: string, row: OutboxRow): Promise<AddMemoryRequest> {
  const groupId = graphitiGroupId(agentId);
  if (row.topic === TOPIC_EVENT) {
    const eventId = rowKey(row);
    const e = (await q.query<{
      kind: string; body: string; at: Date | string; task_id: string | null;
      sender_session: string | null; sender_cap_id: string | null; sender_worker_id: string | null;
      recipient_session: string | null; recipient_cap_id: string | null; recipient_worker_id: string | null;
    }>(
      `SELECT kind, body, at, task_id, sender_session, sender_cap_id, sender_worker_id, recipient_session, recipient_cap_id, recipient_worker_id
         FROM memory_events WHERE agent_id = $1 AND event_id = $2`,
      [agentId, eventId],
    )).rows[0];
    if (!e) throw new Permanent("source event not found");
    const from = party(e.sender_session, e.sender_cap_id, e.sender_worker_id);
    const to = party(e.recipient_session, e.recipient_cap_id, e.recipient_worker_id);
    return {
      name: episodeName(row),
      episodeBody: `[${e.kind}] ${from} -> ${to}\n${clip(e.body, SYNC_BODY_MAX)}`,
      groupId,
      source: "text",
      sourceDescription: `bantou event kind=${e.kind}${e.task_id ? ` task=${e.task_id}` : ""}`,
      referenceTime: iso(e.at),
    };
  }
  if (row.topic === TOPIC_ITEM) {
    const itemId = rowKey(row);
    const it = (await q.query<{ memory_type: string; content: string; status: string; scope: string; valid_from: Date | string | null; created_at: Date | string }>(
      "SELECT memory_type, content, status, scope, valid_from, created_at FROM memory_items WHERE id = $1 AND agent_id = $2",
      [itemId, agentId],
    )).rows[0];
    if (!it) throw new Permanent("source item not found");
    if (it.scope !== "agent_private") throw new Permanent(`scope ${it.scope} is not supported yet`);
    return {
      name: episodeName(row),
      episodeBody: it.content,
      groupId,
      source: "text",
      sourceDescription: `bantou memory item type=${it.memory_type} status=${it.status}`,
      referenceTime: iso(it.valid_from ?? it.created_at),
    };
  }
  throw new Permanent(`unknown topic ${row.topic}`);
}

/** 1 agent 分。run は process の中で重ならない前提（worker 側の枠。別 process との排他は無い） */
export async function syncForAgent(db: Db, deps: SyncDeps, agentId: string): Promise<SyncSummary> {
  const topics = deps.topics ?? DEFAULT_TOPICS;
  const inFlight = deps.inFlight ?? SYNC_IN_FLIGHT;
  const confirmMs = (deps.confirmTimeoutMin ?? SYNC_CONFIRM_TIMEOUT_MIN) * 60_000;
  const now = deps.now ?? (() => new Date());
  const groupId = graphitiGroupId(agentId);
  const s: SyncSummary = { agentId, confirmed: 0, sent: 0, retried: 0, failed: 0, waiting: 0, unavailable: false };

  // 失敗を 1 行に記録する（回数を加算する場合は next_attempt_at と dead-letter も）
  const recordFailure = (id: string, message: string, permanent: boolean) =>
    db.withAgent(agentId, async (q) => {
      const r = (await q.query<{ failed_at: Date | null }>(
        `UPDATE outbox_events SET attempts = attempts + 1, last_error = $3, sent_at = NULL,
                failed_at = CASE WHEN $5::boolean OR attempts + 1 >= $4 THEN $6::timestamptz ELSE NULL END,
                next_attempt_at = $6::timestamptz + make_interval(secs => LEAST(60 * power(2, attempts), 3600))
          WHERE agent_id = $1 AND id = $2 AND processed_at IS NULL RETURNING failed_at`,
        [agentId, id, clip(message, 300), SYNC_MAX_ATTEMPTS, permanent, now().toISOString()],
      )).rows[0];
      if (r?.failed_at) s.failed++;
      else s.retried++;
    });

  // 1. 送信済みの行の反映を確認する
  const sentRows = await db.withAgent(agentId, async (q) =>
    (await q.query<OutboxRow & { episode_uuid: string | null }>(
      `SELECT id::text, topic, idempotency_key, payload, attempts, sent_at, episode_uuid FROM outbox_events
        WHERE agent_id = $1 AND topic = ANY($2::text[]) AND sent_at IS NOT NULL AND processed_at IS NULL AND failed_at IS NULL
        ORDER BY outbox_events.id LIMIT 200`,
      [agentId, topics],
    )).rows,
  );
  if (sentRows.length > 0) {
    let seen: Map<string, string>;
    try {
      seen = new Map((await deps.graphiti.recentEpisodes(groupId, Math.max(50, Math.min(200, sentRows.length * 2)))).map((e) => [e.name, e.uuid]));
    } catch (e) {
      if (e instanceof GraphitiUnavailableError) s.unavailable = true;
      throw e;
    }
    const found = sentRows.flatMap((r) => {
      const uuid = seen.get(episodeName(r));
      return uuid ? [{ id: r.id, uuid }] : [];
    });
    for (const f of found) {
      await db.withAgent(agentId, (q) =>
        q.query("UPDATE outbox_events SET processed_at = $4::timestamptz, episode_uuid = $3, last_error = NULL WHERE agent_id = $1 AND id = $2 AND processed_at IS NULL", [agentId, f.id, f.uuid, now().toISOString()]),
      );
    }
    s.confirmed = found.length;
    const done = new Set(found.map((f) => f.id));
    for (const r of sentRows) {
      if (done.has(r.id) || !r.sent_at) continue;
      if (now().getTime() - new Date(r.sent_at).getTime() >= confirmMs) await recordFailure(r.id, "episode not confirmed in time", false);
    }
  }

  // 2. 待ちの行を送る（送信済み・未確認の行数が inFlight を越えない範囲で、id 順 = 記録の順）
  const waiting = await db.withAgent(agentId, async (q) =>
    Number((await q.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM outbox_events WHERE agent_id = $1 AND topic = ANY($2::text[]) AND sent_at IS NOT NULL AND processed_at IS NULL AND failed_at IS NULL",
      [agentId, topics],
    )).rows[0]!.n),
  );
  const room = inFlight - waiting;
  s.waiting = waiting;
  if (room > 0) {
    const pending = await db.withAgent(agentId, async (q) =>
      (await q.query<OutboxRow>(
        `SELECT id::text, topic, idempotency_key, payload, attempts, sent_at FROM outbox_events
          WHERE agent_id = $1 AND topic = ANY($2::text[]) AND sent_at IS NULL AND processed_at IS NULL AND failed_at IS NULL
            AND (next_attempt_at IS NULL OR next_attempt_at <= $4::timestamptz)
          ORDER BY outbox_events.id LIMIT $3`,
        [agentId, topics, room, now().toISOString()],
      )).rows,
    );
    for (const row of pending) {
      let req: AddMemoryRequest;
      try {
        req = await db.withAgent(agentId, (q) => buildRequest(q, agentId, row));
      } catch (e) {
        if (e instanceof Permanent) {
          await recordFailure(row.id, e.message, true);
          continue;
        }
        throw e;
      }
      try {
        await deps.graphiti.addMemory(req);
      } catch (e) {
        if (e instanceof GraphitiRejectedError) {
          await recordFailure(row.id, e.message, false);
          continue;
        }
        if (e instanceof GraphitiUnavailableError) s.unavailable = true;
        throw e;
      }
      await db.withAgent(agentId, (q) =>
        q.query("UPDATE outbox_events SET sent_at = $3::timestamptz, last_error = NULL WHERE agent_id = $1 AND id = $2", [agentId, row.id, now().toISOString()]),
      );
      s.sent++;
      s.waiting++;
    }
  }
  return s;
}

export interface SyncAllResult {
  results: SyncSummary[];
  errors: { agentId: string; message: string }[];
}

/** 全 agent を順に。1 agent の失敗で他を止めない（Graphiti が落ちている時は全 agent が同じ error になるので、最初の 1 件で打ち切る） */
export async function syncAll(db: Db, deps: SyncDeps): Promise<SyncAllResult> {
  const agents = (await db.query<{ id: string }>("SELECT id FROM agents ORDER BY id")).rows;
  const results: SyncSummary[] = [];
  const errors: { agentId: string; message: string }[] = [];
  for (const a of agents) {
    try {
      results.push(await syncForAgent(db, deps, a.id));
    } catch (e) {
      errors.push({ agentId: a.id, message: e instanceof Error ? e.message : String(e) });
      if (e instanceof GraphitiUnavailableError) break;
    }
  }
  return { results, errors };
}

/** Graphiti の反映の状態（agent ごと）。status 用ではなく log と test 用 */
export async function outboxCounts(db: Db, agentId: string, topics: string[] = DEFAULT_TOPICS): Promise<{ pending: number; sent: number; done: number; deadLetter: number }> {
  const r = (await db.withAgent(agentId, (q) =>
    q.query<{ pending: number; sent: number; done: number; dead: number }>(
      `SELECT (count(*) FILTER (WHERE sent_at IS NULL AND processed_at IS NULL AND failed_at IS NULL))::int AS pending,
              (count(*) FILTER (WHERE sent_at IS NOT NULL AND processed_at IS NULL AND failed_at IS NULL))::int AS sent,
              (count(*) FILTER (WHERE processed_at IS NOT NULL))::int AS done,
              (count(*) FILTER (WHERE failed_at IS NOT NULL))::int AS dead
         FROM outbox_events WHERE agent_id = $1 AND topic = ANY($2::text[])`,
      [agentId, topics],
    ),
  )).rows[0]!;
  return { pending: Number(r.pending), sent: Number(r.sent), done: Number(r.done), deadLetter: Number(r.dead) };
}
