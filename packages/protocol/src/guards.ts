import { PROTOCOL_VERSION, TASK_ID_PATTERN } from "./envelope.js";
import type { AskMessage, Envelope, TaskMessage } from "./envelope.js";

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function optString(v: unknown): boolean {
  return v === undefined || typeof v === "string";
}

/** Common fields of an envelope: `bantou: 1`, known `type`, valid `task_id`, optional `session`. */
export function isEnvelope(v: unknown): v is Envelope {
  if (!isRecord(v)) return false;
  if (v.bantou !== PROTOCOL_VERSION) return false;
  if (v.type !== "task" && v.type !== "ask") return false;
  if (typeof v.task_id !== "string" || !TASK_ID_PATTERN.test(v.task_id)) return false;
  if (!optString(v.session)) return false;
  return v.type === "task" ? hasTaskFields(v) : hasAskFields(v);
}

function hasTaskFields(v: Record<string, unknown>): boolean {
  return typeof v.title === "string" && optString(v.status) && optString(v.body);
}

function hasAskFields(v: Record<string, unknown>): boolean {
  if (typeof v.question !== "string" || !optString(v.title)) return false;
  if (v.options === undefined) return true;
  return (
    Array.isArray(v.options) &&
    v.options.every((o) => isRecord(o) && typeof o.label === "string" && optString(o.description))
  );
}

export function isTaskMessage(v: unknown): v is TaskMessage {
  return isEnvelope(v) && v.type === "task";
}

export function isAskMessage(v: unknown): v is AskMessage {
  return isEnvelope(v) && v.type === "ask";
}

/** Parse message text as an envelope; `undefined` means "non-JSON message" (goes to inbox.jsonl). */
export function parseEnvelope(text: string): Envelope | undefined {
  try {
    const v: unknown = JSON.parse(text.trim());
    return isEnvelope(v) ? v : undefined;
  } catch {
    return undefined;
  }
}
