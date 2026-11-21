import { createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

// Graphiti（公式の MCP server。docs/design/memory-graphiti.md）への薄い client。tool の名前・引数は
// getzep/graphiti の mcp_server/src/graphiti_mcp_server.py（add_memory / get_episodes / search_memory_facts）に合わせる。

/** Graphiti に届かない（接続失敗・timeout・5xx）。入力の問題ではないので、呼び出し側は失敗回数を加算しない */
export class GraphitiUnavailableError extends Error {}
/** Graphiti が tool の呼び出しを断った（ErrorResponse / isError）。同じ入力では直らない事がある */
export class GraphitiRejectedError extends Error {}

export interface AddMemoryRequest {
  name: string;
  episodeBody: string;
  groupId: string;
  source: "text" | "message" | "json";
  sourceDescription: string;
  /** ISO 8601。event / 記憶が実際に起きた時刻（Graphiti の bi-temporal の valid 側） */
  referenceTime: string;
}

export interface GraphitiFact {
  uuid: string;
  fact: string;
  name?: string;
  validAt: string | null;
  invalidAt: string | null;
  /** この fact の出典 episode の uuid（Graphiti の EntityEdge.episodes） */
  episodes: string[];
}

export interface SearchFactsRequest {
  query: string;
  groupId: string;
  maxFacts: number;
  validAtAfter?: string;
  validAtBefore?: string;
  invalidAtAfter?: string;
  invalidAtBefore?: string;
}

/** test では fake に差し替える */
export interface GraphitiClient {
  /** Graphiti の queue への受理まで。反映（抽出・保存）は後で非同期に行われる */
  addMemory(req: AddMemoryRequest): Promise<void>;
  /** group の最近の episode（新しい順）。反映の確認（name で突合）と、Graphiti が付けた uuid の取得に使う */
  recentEpisodes(groupId: string, max: number): Promise<{ uuid: string; name: string }[]>;
  searchFacts(req: SearchFactsRequest): Promise<GraphitiFact[]>;
  close(): Promise<void>;
}

/** Graphiti の group_id は英数字・`-`・`_` だけ（graphiti-core の検証）。agent ID は `.@:` も含むので、潰して hash を付ける */
export function graphitiGroupId(agentId: string): string {
  const slug = agentId.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 48);
  const h = createHash("sha256").update(agentId).digest("hex").slice(0, 8);
  return `private-${slug}-${h}`;
}

type ToolResult = { isError?: boolean; structuredContent?: unknown; content?: { type: string; text?: string }[] };

function parseResult(name: string, r: ToolResult): Record<string, unknown> {
  let body: unknown = r.structuredContent;
  if (body === undefined) {
    const text = r.content?.find((c) => c.type === "text")?.text;
    try {
      body = text === undefined ? undefined : JSON.parse(text);
    } catch {
      body = undefined;
    }
  }
  let o = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  // FastMCP は pydantic の戻り値を { result: <値> } に包んで structuredContent に入れる（実測）。包まれていれば開ける
  if (Object.keys(o).length === 1 && o.result && typeof o.result === "object") o = o.result as Record<string, unknown>;
  if (r.isError || typeof o.error === "string") {
    throw new GraphitiRejectedError(`graphiti ${name}: ${String(o.error ?? r.content?.[0]?.text ?? "tool error").slice(0, 300)}`);
  }
  return o;
}

/** SDK の Client で Graphiti の MCP（Streamable HTTP, `/mcp/`）を呼ぶ。接続は使い回し、失敗したら次の呼び出しで張り直す */
export function createGraphitiMcpClient(opts: { url: string; timeoutMs: number }): GraphitiClient {
  let client: Client | undefined;
  const connect = async (): Promise<Client> => {
    if (client) return client;
    const c = new Client({ name: "bantou-memory", version: "0.0.0" });
    await c.connect(new StreamableHTTPClientTransport(new URL(opts.url)), { timeout: opts.timeoutMs });
    client = c;
    return c;
  };
  const drop = async () => {
    const c = client;
    client = undefined;
    await c?.close().catch(() => {});
  };
  const call = async (name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> => {
    let r: ToolResult;
    try {
      r = (await (await connect()).callTool({ name, arguments: args }, undefined, { timeout: opts.timeoutMs })) as ToolResult;
    } catch (e) {
      await drop();
      // URL・本文は message に入れない（種類だけ）
      throw new GraphitiUnavailableError(`graphiti ${name}: ${e instanceof Error ? e.name : "error"}${(e as { code?: unknown }).code !== undefined ? ` (code ${String((e as { code?: unknown }).code)})` : ""}`);
    }
    return parseResult(name, r);
  };
  return {
    async addMemory(req) {
      await call("add_memory", {
        name: req.name,
        episode_body: req.episodeBody,
        group_id: req.groupId,
        source: req.source,
        source_description: req.sourceDescription,
        reference_time: req.referenceTime,
      });
    },
    async recentEpisodes(groupId, max) {
      const o = await call("get_episodes", { group_ids: [groupId], max_episodes: max });
      const eps = Array.isArray(o.episodes) ? (o.episodes as { uuid?: unknown; name?: unknown }[]) : [];
      return eps.flatMap((e) => (typeof e.uuid === "string" && typeof e.name === "string" ? [{ uuid: e.uuid, name: e.name }] : []));
    },
    async searchFacts(req) {
      const o = await call("search_memory_facts", {
        query: req.query,
        group_ids: [req.groupId],
        max_facts: req.maxFacts,
        ...(req.validAtAfter ? { valid_at_after: req.validAtAfter } : {}),
        ...(req.validAtBefore ? { valid_at_before: req.validAtBefore } : {}),
        ...(req.invalidAtAfter ? { invalid_at_after: req.invalidAtAfter } : {}),
        ...(req.invalidAtBefore ? { invalid_at_before: req.invalidAtBefore } : {}),
      });
      const facts = Array.isArray(o.facts) ? (o.facts as Record<string, unknown>[]) : [];
      return facts.map((f) => ({
        uuid: String(f.uuid ?? ""),
        fact: String(f.fact ?? ""),
        ...(typeof f.name === "string" ? { name: f.name } : {}),
        validAt: typeof f.valid_at === "string" ? f.valid_at : null,
        invalidAt: typeof f.invalid_at === "string" ? f.invalid_at : null,
        episodes: Array.isArray(f.episodes) ? f.episodes.filter((x): x is string => typeof x === "string") : [],
      }));
    },
    close: drop,
  };
}
