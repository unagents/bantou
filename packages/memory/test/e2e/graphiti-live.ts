// 実際の Graphiti（公式 MCP server + Neo4j）に対する手動の確認用 script。`npm test` には含まれない（*.test.ts ではない）。
// 動いている外部記憶（PostgreSQL・Ollama・chatp）には触れない: DB は PGlite（ファイルは E2E_DATA_DIR）、Graphiti の URL は GRAPHITI_MCP_URL で指す。
// 使い方（docs/design/memory-graphiti.md の「実測」）:
//   node --import tsx test/e2e/graphiti-live.ts <seed|sync|search|counts|group|episodes|dup> [引数]
// 1 回の起動で 1 つの操作だけ行い、待ちの loop は持たない（反映の確認は sync を時間を置いて再度呼ぶ）。
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import type { Db } from "../../server/utils/db.ts";
import { recordEvent } from "../../server/utils/events.ts";
import { createGraphitiMcpClient, graphitiGroupId } from "../../server/utils/graphiti.ts";
import { graphSearch } from "../../server/utils/graphiti-recall.ts";
import { TOPIC_EVENT, TOPIC_ITEM, outboxCounts, syncForAgent } from "../../server/utils/graphiti-sync.ts";
import { readUpMigration } from "../helpers/fakes.ts";

const url = process.env.GRAPHITI_MCP_URL ?? "";
const dataDir = process.env.E2E_DATA_DIR ?? "";
const agent = process.env.E2E_AGENT ?? "master:cap.1@e2e";
if (!url || !dataDir) throw new Error("GRAPHITI_MCP_URL と E2E_DATA_DIR が要る");

const raw = new PGlite(dataDir, { extensions: { vector } });
await raw.waitReady;
if (((await raw.query<{ n: number }>("SELECT count(*)::int AS n FROM pg_class WHERE relname = 'outbox_events'")).rows[0]!.n) === 0) {
  await raw.exec("CREATE EXTENSION IF NOT EXISTS vector");
  await raw.exec(readUpMigration());
}
const db: Db = {
  query: (sql, params) => raw.query(sql, params as unknown[]) as never,
  withAgent: (agentId, fn) =>
    raw.transaction(async (tx) => {
      await tx.query("SELECT set_config('app.agent_id', $1, true)", [agentId]);
      return fn({ query: (sql, params) => tx.query(sql, params as unknown[]) as never });
    }),
  close: () => raw.close(),
};
const graphiti = createGraphitiMcpClient({ url, timeoutMs: 30000 });
const topics = (process.env.E2E_TOPICS ?? `${TOPIC_ITEM},${TOPIC_EVENT}`).split(",");
const [cmd = "", ...args] = process.argv.slice(2);

try {
  if (cmd === "seed") {
    // args: JSON 配列 [{ id, kind, body, at, item? }]。event を record し、item があれば item も作る（出典 = その event）
    const specs = JSON.parse(args[0] ?? "[]") as { id: string; kind: string; body: string; at: string; item?: { type: string; content: string; status: string } }[];
    for (const s of specs) {
      await recordEvent(db, agent, { eventId: s.id, sender: { session: "master" }, kind: s.kind, body: s.body, at: s.at });
      if (s.item) {
        await db.withAgent(agent, async (q) => {
          const id = (await q.query<{ id: string }>(
            "INSERT INTO memory_items (agent_id, memory_type, content, content_norm, status, valid_from) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id::text",
            [agent, s.item!.type, s.item!.content, s.item!.content.toLowerCase(), s.item!.status, s.at],
          )).rows[0]!.id;
          await q.query("INSERT INTO memory_sources (item_id, agent_id, event_id) VALUES ($1,$2,$3)", [id, agent, s.id]);
          await q.query("INSERT INTO outbox_events (agent_id, topic, idempotency_key, payload) VALUES ($1,$2,$3,$4::jsonb)", [agent, TOPIC_ITEM, id, JSON.stringify({ itemId: id })]);
        });
      }
    }
    console.log(JSON.stringify({ seeded: specs.length }));
  } else if (cmd === "sync") {
    console.log(JSON.stringify(await syncForAgent(db, { graphiti, topics }, agent)));
  } else if (cmd === "counts") {
    console.log(JSON.stringify({ item: await outboxCounts(db, agent, [TOPIC_ITEM]), event: await outboxCounts(db, agent, [TOPIC_EVENT]) }));
  } else if (cmd === "group") {
    console.log(graphitiGroupId(agent));
  } else if (cmd === "search") {
    console.log(JSON.stringify(await graphSearch(db, graphiti, agent, { query: args[0] ?? "", maxFacts: 10 }), null, 2));
  } else if (cmd === "episodes") {
    console.log(JSON.stringify(await graphiti.recentEpisodes(graphitiGroupId(agent), 200), null, 1));
  } else if (cmd === "dup") {
    // 同じ name の episode をもう一度 add_memory したら何が起きるか（再送の冪等性の確認）。内容は最初の item と同じ
    const r = await db.withAgent(agent, async (q) =>
      (await q.query<{ id: string; content: string; valid_from: string }>("SELECT id::text, content, valid_from FROM memory_items ORDER BY created_at LIMIT 1")).rows[0]!,
    );
    await graphiti.addMemory({ name: `item:${r.id}`, episodeBody: r.content, groupId: graphitiGroupId(agent), source: "text", sourceDescription: "dup", referenceTime: new Date(r.valid_from).toISOString() });
    console.log(JSON.stringify({ resent: `item:${r.id}` }));
  } else {
    throw new Error(`unknown command: ${cmd}`);
  }
} finally {
  await graphiti.close();
  await raw.close();
}
