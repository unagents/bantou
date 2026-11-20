import { z } from "zod";
import type { Db } from "./db";

export const EVENT_KINDS = ["user_prompt", "assistant_message", "task", "result", "report", "reply"] as const;

// PostgreSQL の text は NUL を保存できない。DB error（500 相当）にせず入力検証で弾く
const noNul = (s: string) => !s.includes("\u0000");
const id128 = z.string().min(1).max(128).refine(noNul, "NUL 文字は使えない");
const DAY_MS = 24 * 60 * 60 * 1000;
const party = z.object({ session: id128.optional(), capId: id128.optional(), workerId: id128.optional() });

/** event tool の入力。agent_id は含めない（認証済みの X-Agent-Id から確定する） */
export const eventShape = {
  eventId: id128.describe("冪等キー。同じ eventId の再送は無視される"),
  sender: party.describe("送り手（session 名 / cap_id / worker_id）"),
  recipient: party.optional().describe("受け手（session 名 / cap_id / worker_id）"),
  remoteId: id128.optional(),
  taskId: id128.optional(),
  kind: z.enum(EVENT_KINDS),
  body: z.string().min(1).max(65536).refine(noNul, "NUL 文字は使えない"),
  at: z.iso
    .datetime({ offset: true })
    .refine((s) => Date.parse(s) <= Date.now() + DAY_MS, "at は現在から 1 日より先にできない")
    .describe("発生時刻（ISO 8601）"),
};
export const eventSchema = z.object(eventShape);
export type EventInput = z.infer<typeof eventSchema>;

export async function recordEvent(db: Db, agentId: string, raw: unknown): Promise<{ status: "recorded" | "duplicate"; eventId: string }> {
  const e = eventSchema.parse(raw);
  return db.withAgent(agentId, async (q) => {
    await q.query("INSERT INTO agents (id) VALUES ($1) ON CONFLICT DO NOTHING", [agentId]);
    const ins = await q.query(
      `INSERT INTO memory_events
         (agent_id, event_id, sender_session, sender_cap_id, sender_worker_id,
          recipient_session, recipient_cap_id, recipient_worker_id, remote_id, task_id, kind, body, at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       ON CONFLICT (agent_id, event_id) DO NOTHING
       RETURNING event_id`,
      [
        agentId, e.eventId,
        e.sender.session ?? null, e.sender.capId ?? null, e.sender.workerId ?? null,
        e.recipient?.session ?? null, e.recipient?.capId ?? null, e.recipient?.workerId ?? null,
        e.remoteId ?? null, e.taskId ?? null, e.kind, e.body, e.at,
      ],
    );
    if (ins.rows.length === 0) {
      // 同じ eventId で本文が違う再送は、先の event を正として無視する。気づけるよう warn を残す（本文は log に出さない）
      const prev = await q.query<{ same: boolean }>(
        "SELECT (body = $3) AS same FROM memory_events WHERE agent_id = $1 AND event_id = $2",
        [agentId, e.eventId, e.body],
      );
      if (prev.rows[0] && !prev.rows[0].same) {
        console.warn(`[memory] event ${e.eventId} (agent ${agentId}) was resent with a different body; ignored`);
      }
      return { status: "duplicate" as const, eventId: e.eventId };
    }
    // Graphiti 同期用 Outbox（同じ transaction。event_id が冪等キー）。反映は Phase 2
    await q.query(
      `INSERT INTO outbox_events (agent_id, topic, idempotency_key, payload)
       VALUES ($1, 'graphiti.episode', $2, $3::jsonb) ON CONFLICT DO NOTHING`,
      [agentId, e.eventId, JSON.stringify({ eventId: e.eventId, kind: e.kind, at: e.at })],
    );
    return { status: "recorded" as const, eventId: e.eventId };
  });
}
