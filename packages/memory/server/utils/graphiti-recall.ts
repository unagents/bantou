import type { Db } from "./db";
import type { GraphitiClient, SearchFactsRequest } from "./graphiti";
import { graphitiGroupId } from "./graphiti";
import { TOPIC_EVENT, TOPIC_ITEM } from "./graphiti-sync";

// Graphiti の関係・時間軸の検索（設計書 §10 の Graphiti 検索）。fact の出典（episode）を Outbox の行経由で
// PostgreSQL の item / event に戻し、出典付きで返す。recall / context の tool への接続は未決
// （docs/design/memory-graphiti.md の未決 4）なので、tool からはまだ呼ばない。

export interface GraphFact {
  id: string;
  fact: string;
  validAt: string | null;
  invalidAt: string | null;
  /** Graphiti が LLM で組み立てた物なので常に inferred。確定にするのは PostgreSQL の item だけ（設計書 §10） */
  status: "inferred";
  origin: "graphiti";
  /** 出典 episode のうち item に当たる物（PostgreSQL の memory_items.id）と、その item の現在の status */
  sourceItems: { id: string; status: string }[];
  /** 出典の event（event の episode 由来 + item の出典 event） */
  sourceEventIds: string[];
}

export async function graphSearch(
  db: Db,
  graphiti: GraphitiClient,
  agentId: string,
  req: Omit<SearchFactsRequest, "groupId">,
): Promise<GraphFact[]> {
  const facts = await graphiti.searchFacts({ ...req, groupId: graphitiGroupId(agentId) });
  const uuids = [...new Set(facts.flatMap((f) => f.episodes))];
  if (uuids.length === 0) {
    return facts.map((f) => ({ id: f.uuid, fact: f.fact, validAt: f.validAt, invalidAt: f.invalidAt, status: "inferred", origin: "graphiti", sourceItems: [], sourceEventIds: [] }));
  }
  const map = await db.withAgent(agentId, async (q) => {
    const rows = (await q.query<{ episode_uuid: string; topic: string; idempotency_key: string }>(
      "SELECT episode_uuid, topic, idempotency_key FROM outbox_events WHERE agent_id = $1 AND episode_uuid = ANY($2::text[])",
      [agentId, uuids],
    )).rows;
    const itemIds = rows.filter((r) => r.topic === TOPIC_ITEM).map((r) => r.idempotency_key);
    const items = itemIds.length
      ? (await q.query<{ id: string; status: string }>("SELECT id::text, status FROM memory_items WHERE agent_id = $1 AND id = ANY($2::uuid[])", [agentId, itemIds])).rows
      : [];
    const srcs = itemIds.length
      ? (await q.query<{ item_id: string; event_id: string }>("SELECT item_id::text, event_id FROM memory_sources WHERE agent_id = $1 AND item_id = ANY($2::uuid[])", [agentId, itemIds])).rows
      : [];
    const byEpisode = new Map<string, { items: { id: string; status: string }[]; events: string[] }>();
    for (const r of rows) {
      const e = byEpisode.get(r.episode_uuid) ?? { items: [], events: [] };
      if (r.topic === TOPIC_EVENT) e.events.push(r.idempotency_key);
      if (r.topic === TOPIC_ITEM) {
        const it = items.find((i) => i.id === r.idempotency_key);
        if (it) e.items.push(it);
        for (const s of srcs) if (s.item_id === r.idempotency_key) e.events.push(s.event_id);
      }
      byEpisode.set(r.episode_uuid, e);
    }
    return byEpisode;
  });
  return facts.map((f) => {
    const items = new Map<string, { id: string; status: string }>();
    const events = new Set<string>();
    for (const u of f.episodes) {
      const e = map.get(u);
      if (!e) continue;
      for (const i of e.items) items.set(i.id, i);
      for (const ev of e.events) events.add(ev);
    }
    return {
      id: f.uuid,
      fact: f.fact,
      validAt: f.validAt,
      invalidAt: f.invalidAt,
      status: "inferred" as const,
      origin: "graphiti" as const,
      sourceItems: [...items.values()],
      sourceEventIds: [...events].sort(),
    };
  });
}
