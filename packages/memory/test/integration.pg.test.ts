// docker の実 PostgreSQL（pgvector/pgvector:pg17）で動かす統合 test。docker が無ければ skip（理由を出す）
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { TestDb } from "./helpers/fakes.ts";
import { fakeChat, ev } from "./helpers/fakes.ts";
import { recordEvent } from "../server/utils/events.ts";
import { extractForAgent } from "../server/utils/extract.ts";
import { createDockerPgTestDb, dockerSkipReason } from "./helpers/pgdocker.ts";
import { defineIntegration } from "./helpers/suite.ts";

const reason = dockerSkipReason();
if (reason) console.log(`# integration (PostgreSQL in docker) skipped: ${reason}`);

describe("integration (PostgreSQL in docker)", { skip: reason ?? false }, () => defineIntegration(createDockerPgTestDb, concurrencyTests));

/**
 * 真の並行 transaction（pool の複数接続）が要る test。PGlite は単一接続なので、ここ（docker の実 PostgreSQL）でだけ検証する。
 * - FOR UPDATE SKIP LOCKED を外すと、同時に claim した run が同じ event を取り、LLM に二重に送られる
 */
function concurrencyTests(getDb: () => TestDb): void {
  test("並行: 同時に走らせた extractForAgent が同じ event を二重に取らない（SKIP LOCKED + lease）", async () => {
    const t = getDb();
    const a = `agent-conc-${process.pid}`;
    const total = 60;
    for (let i = 0; i < total; i++) {
      await recordEvent(t.db, a, ev({ eventId: `${a}-${String(i).padStart(3, "0")}`, body: `並行の事実 ${i}`, at: new Date(Date.UTC(2026, 10, 1, 0, 0, i)).toISOString() }));
    }
    const sent: string[] = [];
    const chat = fakeChat(async (req) => {
      const events = (JSON.parse(req.user) as { events: { id: string; body: string }[] }).events;
      sent.push(...events.map((e) => e.id));
      await new Promise((r) => setTimeout(r, 50));
      return {
        candidates: events.map((e) => ({ memoryType: "semantic", content: `抽出: ${e.body}`, status: "inferred", sourceEventIds: [e.id], validFrom: null })),
      };
    });
    const runs = await Promise.all(Array.from({ length: 6 }, () => extractForAgent(t.db, { chat, batchSize: 10 }, a)));
    assert.equal(sent.length, new Set(sent).size, "同じ event が複数の run の LLM 入力に入っていない");
    assert.equal(sent.length, total, "6 並列 × 10 件で全 event を過不足なく取る");
    assert.equal(runs.reduce((n, r) => n + r.accepted, 0), total);
    const left = await t.asSuper(async (sq) => (await sq.query("SELECT 1 FROM memory_events WHERE agent_id = $1 AND processed_at IS NULL", [a])).rows.length);
    assert.equal(left, 0);
  });
}
