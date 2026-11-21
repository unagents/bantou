// 環境変数の読み取り。値（token 等）は log に出さない。
import { DEFAULT_EMBED_BATCH, DEFAULT_EMBED_RUN_MS } from "./embed";

/** MEMORY_EMBED_RUN_MS の上限。毎分の起動（60 秒）より短く保つ（run が 60 秒を越えると、次の起動が飛ぶ） */
export const MAX_EMBED_RUN_MS = 55_000;

export interface MemoryEnv {
  databaseUrl: string;
  embedModel: string;
  embedDim: number;
  ollamaUrl: string;
  chatpUrl: string;
  chatpToken: string;
  chatpModel: string;
  extractBatch: number;
  /** chatp（抽出 LLM）の timeout。CHATP_TIMEOUT_MS、無ければ MEMORY_HTTP_TIMEOUT_MS（互換） */
  chatTimeoutMs: number;
  /** 溜まった分の埋め込み（1 回の /api/embed）の timeout。chatp とは別の設定 */
  embedTimeoutMs: number;
  /** recall の query の埋め込みの timeout */
  recallEmbedTimeoutMs: number;
  /** 1 回の /api/embed に送る件数 */
  embedBatch: number;
  /** 1 回の run で埋め込みに使う時間の上限（毎分の起動が飛ばないよう、MAX_EMBED_RUN_MS で頭打ちにする） */
  embedRunMs: number;
  /** Graphiti の MCP endpoint（例 http://127.0.0.1:8000/mcp/）。空なら Outbox を消費しない（今まで通り積むだけ） */
  graphitiUrl: string;
  /** Graphiti へ反映する Outbox の topic（カンマ区切り）。既定は graphiti.memory_item のみ（未決 2 の暫定） */
  graphitiTopics: string[];
  graphitiTimeoutMs: number;
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
    chatTimeoutMs: int(env.CHATP_TIMEOUT_MS, int(env.MEMORY_HTTP_TIMEOUT_MS, 120000)),
    // 埋め込みは MEMORY_HTTP_TIMEOUT_MS を引き継がない（chatp に合わせて延ばした値で Ollama を長く待たないため）
    embedTimeoutMs: int(env.MEMORY_EMBED_TIMEOUT_MS, 60000),
    recallEmbedTimeoutMs: int(env.MEMORY_RECALL_EMBED_TIMEOUT_MS, 60000),
    embedBatch: int(env.MEMORY_EMBED_BATCH, DEFAULT_EMBED_BATCH),
    embedRunMs: Math.min(int(env.MEMORY_EMBED_RUN_MS, DEFAULT_EMBED_RUN_MS), MAX_EMBED_RUN_MS),
    graphitiUrl: env.GRAPHITI_MCP_URL ?? "",
    graphitiTopics: (env.GRAPHITI_TOPICS ?? "graphiti.memory_item").split(",").map((s) => s.trim()).filter(Boolean),
    graphitiTimeoutMs: int(env.GRAPHITI_TIMEOUT_MS, 30000),
  };
}
