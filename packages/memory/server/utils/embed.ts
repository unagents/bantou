import type { Db } from "./db";

/** 埋め込み。差し替え可能（test は決定論的な fake） */
export interface Embedder {
  readonly model: string;
  readonly dim: number;
  embed(texts: string[]): Promise<number[][]>;
}

/** Ollama の POST /api/embed。model と次元は環境変数（migration の vector(N) と一致が必要） */
export function createOllamaEmbedder(opts: { url: string; model: string; dim: number; timeoutMs: number }): Embedder {
  return {
    model: opts.model,
    dim: opts.dim,
    async embed(texts) {
      const res = await fetch(`${opts.url}/api/embed`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: opts.model, input: texts }),
        signal: AbortSignal.timeout(opts.timeoutMs),
      });
      if (!res.ok) throw new Error(`ollama embed failed: HTTP ${res.status}`);
      const j = (await res.json()) as { embeddings?: number[][] };
      return checkVectors(j.embeddings, texts.length, opts.dim);
    },
  };
}

export function checkVectors(v: unknown, n: number, dim: number): number[][] {
  if (!Array.isArray(v) || v.length !== n) throw new Error(`embedding count mismatch (want ${n})`);
  for (const e of v) {
    if (!Array.isArray(e) || e.length !== dim) {
      throw new Error(`embedding dimension mismatch: want ${dim}, got ${Array.isArray(e) ? e.length : "none"}. MEMORY_EMBED_DIM と migration の vector(N) を model に合わせること`);
    }
  }
  return v as number[][];
}

/** pgvector のリテラル '[a,b,...]'。値は param で渡す */
export function toVectorLiteral(v: number[]): string {
  return `[${v.join(",")}]`;
}

/** 埋め込み未設定の item を埋める。失敗した分は次回に回る */
export async function embedPending(db: Db, agentId: string, embedder: Embedder, limit = 100): Promise<number> {
  const rows = await db.withAgent(agentId, async (q) =>
    (await q.query<{ id: string; content: string }>(
      "SELECT id, content FROM memory_items WHERE agent_id = $1 AND (embedding IS NULL OR embed_model IS DISTINCT FROM $2) ORDER BY created_at LIMIT $3",
      [agentId, embedder.model, limit],
    )).rows,
  );
  if (rows.length === 0) return 0;
  const vecs = checkVectors(await embedder.embed(rows.map((r) => r.content)), rows.length, embedder.dim);
  await db.withAgent(agentId, async (q) => {
    for (let i = 0; i < rows.length; i++) {
      await q.query(
        "UPDATE memory_items SET embedding = $1::vector, embed_model = $2, updated_at = now() WHERE id = $3 AND agent_id = $4",
        [toVectorLiteral(vecs[i]!), embedder.model, rows[i]!.id, agentId],
      );
    }
  });
  return rows.length;
}
