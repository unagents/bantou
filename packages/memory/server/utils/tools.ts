import type { McpRequestExtra } from "@nuxtjs/mcp-toolkit/server";
import { recordEvent } from "./events";
import { buildContext, explain, recall } from "./recall";
import { getRuntime } from "./runtime";

/** 認証済みの agent。middleware が X-Agent-Id を検証済み。無ければ tool を動かさない */
export function agentIdOf(extra: Pick<McpRequestExtra, "requestInfo">): string {
  const v = extra.requestInfo?.headers?.["x-agent-id"];
  const id = (Array.isArray(v) ? v[0] : v)?.trim();
  if (!id) throw new Error("X-Agent-Id is required");
  return id;
}

export async function handleEvent(agentId: string, args: unknown) {
  const { db } = await getRuntime();
  return recordEvent(db, agentId, args);
}
export async function handleRecall(agentId: string, args: unknown) {
  const { db, embedder } = await getRuntime();
  return recall(db, embedder, agentId, args);
}
export async function handleContext(agentId: string, args: unknown) {
  const { db } = await getRuntime();
  return { ...(await buildContext(db, agentId, args)) };
}
export async function handleExplain(agentId: string, args: unknown) {
  const { db } = await getRuntime();
  return { ...(await explain(db, agentId, args)) };
}
