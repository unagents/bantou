import { readEnv } from "./config";
import { createPgDb, type Db } from "./db";
import { createOllamaEmbedder, type Embedder } from "./embed";
import { createChatClient, type ChatClient } from "./extract";

export interface Runtime {
  db: Db;
  embedder: Embedder;
  chat: ChatClient;
  extractBatch: number;
}

let current: Runtime | undefined;
let pending: Promise<Runtime> | undefined;

/** test が fake を差し込む */
export function setRuntime(r: Runtime | undefined): void {
  current = r;
  pending = undefined;
}

/** migration の vector(N) と MEMORY_EMBED_DIM が違うまま動かさない */
export async function checkEmbeddingDim(db: Db, dim: number): Promise<void> {
  const r = await db.query<{ dim: number }>(
    "SELECT atttypmod AS dim FROM pg_attribute WHERE attrelid = 'memory_items'::regclass AND attname = 'embedding'",
  );
  const actual = r.rows[0]?.dim;
  if (actual !== dim) {
    throw new Error(`memory_items.embedding is vector(${actual}) but MEMORY_EMBED_DIM=${dim}. model に合う migration を適用するか MEMORY_EMBED_DIM を直すこと`);
  }
}

export function getRuntime(): Promise<Runtime> {
  if (current) return Promise.resolve(current);
  pending ??= (async () => {
    const env = readEnv();
    if (!env.databaseUrl) throw new Error("MEMORY_DATABASE_URL is not set");
    const db = createPgDb(env.databaseUrl);
    await checkEmbeddingDim(db, env.embedDim);
    current = {
      db,
      embedder: createOllamaEmbedder({ url: env.ollamaUrl, model: env.embedModel, dim: env.embedDim, timeoutMs: env.timeoutMs }),
      chat: createChatClient({ url: env.chatpUrl, token: env.chatpToken, model: env.chatpModel, timeoutMs: env.timeoutMs }),
      extractBatch: env.extractBatch,
    };
    return current;
  })().catch((e) => {
    pending = undefined;
    throw e;
  });
  return pending;
}
