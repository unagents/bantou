// 環境変数の読み取り。値（token 等）は log に出さない。
export interface MemoryEnv {
  databaseUrl: string;
  embedModel: string;
  embedDim: number;
  ollamaUrl: string;
  chatpUrl: string;
  chatpToken: string;
  chatpModel: string;
  extractBatch: number;
  timeoutMs: number;
}

export function readEnv(env: Record<string, string | undefined> = process.env): MemoryEnv {
  const int = (v: string | undefined, d: number) => {
    const n = Number(v);
    return Number.isInteger(n) && n > 0 ? n : d;
  };
  return {
    databaseUrl: env.MEMORY_DATABASE_URL ?? "",
    embedModel: env.MEMORY_EMBED_MODEL || "nomic-embed-text",
    embedDim: int(env.MEMORY_EMBED_DIM, 768),
    ollamaUrl: (env.OLLAMA_URL ?? "http://127.0.0.1:11434").replace(/\/+$/, ""),
    chatpUrl: (env.CHATP_URL ?? "").replace(/\/+$/, ""),
    chatpToken: env.CHATP_TOKEN ?? "",
    chatpModel: env.CHATP_MODEL || "claude",
    extractBatch: int(env.MEMORY_EXTRACT_BATCH, 50),
    timeoutMs: int(env.MEMORY_HTTP_TIMEOUT_MS, 120000),
  };
}
