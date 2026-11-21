import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ConversationInfo } from "@agent-hand/bantou-protocol";
import { runLogDir } from "./paths";

/** 会話（claude の session 1 つ）の記録。logs/conversation.json。state.json の形は変えない。 */
export interface ConversationRecord {
  started_at: string | null;
  tasks: number;
  context_tokens: number | null;
  context_window: number | null;
  usage_at: string | null;
  last_error_text?: string;
}

const conversationFile = (dir: string): string => join(runLogDir(dir), "conversation.json");
/** 閉じた会話の履歴（追記のみ）。 */
const closedFile = (dir: string): string => join(runLogDir(dir), "closed.jsonl");

const numOrNull = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const strOrNull = (v: unknown): string | null => (typeof v === "string" ? v : null);

export const emptyConversation = (): ConversationRecord => ({ started_at: null, tasks: 0, context_tokens: null, context_window: null, usage_at: null });

/** 無い・壊れている時は空の記録（会話の記録は補助情報なので、読めなくても実行を止めない）。 */
export async function readConversation(dir: string): Promise<ConversationRecord> {
  try {
    const d = JSON.parse(await readFile(conversationFile(dir), "utf8")) as Record<string, unknown>;
    const out: ConversationRecord = {
      started_at: strOrNull(d.started_at),
      tasks: typeof d.tasks === "number" && Number.isInteger(d.tasks) && d.tasks >= 0 ? d.tasks : 0,
      context_tokens: numOrNull(d.context_tokens),
      context_window: numOrNull(d.context_window),
      usage_at: strOrNull(d.usage_at),
    };
    if (typeof d.last_error_text === "string" && d.last_error_text !== "") out.last_error_text = d.last_error_text;
    return out;
  } catch {
    return emptyConversation();
  }
}

export async function writeConversation(dir: string, c: ConversationRecord): Promise<void> {
  await mkdir(runLogDir(dir), { recursive: true });
  await writeFile(conversationFile(dir), JSON.stringify(c) + "\n");
}

/** status に載せる形。context_percent は小数 1 桁。 */
export function toConversationInfo(c: ConversationRecord): ConversationInfo {
  const percent = c.context_tokens !== null && c.context_window ? Math.round((c.context_tokens / c.context_window) * 1000) / 10 : null;
  return {
    started_at: c.started_at,
    tasks: c.tasks,
    context_tokens: c.context_tokens,
    context_window: c.context_window,
    context_percent: percent,
    usage_at: c.usage_at,
    ...(c.last_error_text !== undefined ? { last_error_text: c.last_error_text } : {}),
  };
}

/** 閉じた会話を logs/closed.jsonl に 1 行足す（消さずに残す）。 */
export async function appendClosed(dir: string, entry: { closed_at: string; session_id: string | null; reason: string; conversation: ConversationRecord }): Promise<void> {
  await mkdir(runLogDir(dir), { recursive: true });
  await appendFile(closedFile(dir), JSON.stringify(entry) + "\n");
}
