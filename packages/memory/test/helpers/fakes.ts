import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import type { Db } from "../../server/utils/db.ts";
import type { Embedder } from "../../server/utils/embed.ts";
import type { ChatClient } from "../../server/utils/extract.ts";

export const DIM = 768;

/** 決定論的な fake 埋め込み: NFKC・小文字化した文字 bigram を hash して L2 正規化（語が重なるほど cosine が高い） */
export function fakeEmbedder(model = "fake-embed"): Embedder & { calls: string[][] } {
  const calls: string[][] = [];
  const vec = (text: string) => {
    const v = new Array<number>(DIM).fill(0);
    const s = text.normalize("NFKC").toLowerCase().replace(/\s+/g, "");
    for (let i = 0; i < s.length - 1; i++) {
      let h = 2166136261;
      for (const ch of s.slice(i, i + 2)) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
      v[(h >>> 0) % DIM]! += 1;
    }
    const n = Math.sqrt(v.reduce((a, x) => a + x * x, 0)) || 1;
    return v.map((x) => x / n);
  };
  return {
    model,
    dim: DIM,
    calls,
    async embed(texts) {
      calls.push(texts);
      return texts.map(vec);
    },
  };
}

export type ChatScript = (req: { system: string; user: string }) => unknown | Promise<unknown>;

export function fakeChat(script: ChatScript): ChatClient & { requests: { system: string; user: string; schemaName: string; schema: object }[] } {
  const requests: { system: string; user: string; schemaName: string; schema: object }[] = [];
  return {
    requests,
    async completeJson(req) {
      requests.push(req);
      return script(req);
    },
  };
}

export interface TestDb {
  db: Db;
  /** RLS を受けない superuser として実行する（検証用） */
  asSuper<T>(fn: () => Promise<T>): Promise<T>;
  raw: PGlite;
  close(): Promise<void>;
}

/** PGlite（WASM の本物の PostgreSQL + pgvector）に migration を当て、非 superuser role で接続する（RLS を効かせるため） */
export async function createTestDb(): Promise<TestDb> {
  const raw = new PGlite({ extensions: { vector } });
  const sql = readFileSync(fileURLToPath(new URL("../../migrations/001_init.sql", import.meta.url)), "utf8");
  const up = sql.split("-- Up Migration")[1]!.split("-- Down Migration")[0]!;
  await raw.exec("CREATE EXTENSION IF NOT EXISTS vector");
  await raw.exec(up);
  await raw.exec("CREATE ROLE memory_app NOLOGIN");
  await raw.exec("GRANT ALL ON ALL TABLES IN SCHEMA public TO memory_app");
  await raw.exec("GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO memory_app");
  await raw.exec("SET ROLE memory_app");
  const db: Db = {
    query: (sql, params) => raw.query(sql, params as unknown[]) as never,
    withAgent: (agentId, fn) =>
      raw.transaction(async (tx) => {
        await tx.query("SELECT set_config('app.agent_id', $1, true)", [agentId]);
        return fn({ query: (sql, params) => tx.query(sql, params as unknown[]) as never });
      }),
    close: () => raw.close(),
  };
  return {
    db,
    raw,
    asSuper: async (fn) => {
      await raw.exec("RESET ROLE");
      try {
        return await fn();
      } finally {
        await raw.exec("SET ROLE memory_app");
      }
    },
    close: () => raw.close(),
  };
}

let seq = 0;
export function ev(over: Partial<{ eventId: string; kind: string; body: string; at: string; taskId: string; remoteId: string }> = {}) {
  seq++;
  return {
    eventId: over.eventId ?? `e${seq}`,
    sender: { session: "master" },
    recipient: { workerId: "w1" },
    kind: over.kind ?? "user_prompt",
    body: over.body ?? `body ${seq}`,
    at: over.at ?? "2026-11-01T00:00:00Z",
    ...(over.taskId ? { taskId: over.taskId } : {}),
    ...(over.remoteId ? { remoteId: over.remoteId } : {}),
  };
}
