/**
 * Work session -> bantou messages. Spec of record: docs/protocol.md.
 * One JSON object goes in the messenger `send_message` text, `to = "bantou-core"`.
 */

/** bantou's messenger peer name. */
export const CORE_NAME = "bantou-core";

/** Protocol version carried in `bantou`. */
export const PROTOCOL_VERSION = 1 as const;

/** `type` values of an envelope. `ping` is a messenger mode, not an envelope type. */
export type MessageType = "task" | "ask";

/** Common fields (docs/protocol.md "Common fields"). */
export interface EnvelopeBase {
  /** Protocol version, always 1. */
  bantou: typeof PROTOCOL_VERSION;
  type: MessageType;
  /** Stable task id = frontmatter `id` of the task md. `[A-Za-z0-9_-]` only. */
  task_id: string;
  /** Session name (= tag). Defaults to the sender's messenger name. */
  session?: string;
}

/** Pattern of a valid `task_id`. */
export const TASK_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

/** `task`: create / update a task. */
export interface TaskMessage extends EnvelopeBase {
  type: "task";
  /** Task title (= md file name). Never changed by messages for a known task. */
  title: string;
  /** Cork status, e.g. "Todo" | "Doing" | "Done". Defaults to "Todo" on create. */
  status?: string;
  /** What the work is. Becomes the md body; sending again replaces it. */
  body?: string;
}

/** One choice of an `ask`. */
export interface AskOption {
  label: string;
  description?: string;
}

/** `ask`: wait for the user's reply. */
export interface AskMessage extends EnvelopeBase {
  type: "ask";
  title?: string;
  question: string;
  /** May be empty (free answer only). The user can always answer in free text. */
  options?: AskOption[];
}

export type Envelope = TaskMessage | AskMessage;

// -- ping ---------------------------------------------------------------------

/**
 * `ping` is not a JSON envelope. The session calls the messenger `send_ping`
 * tool (`to = "bantou-core"`) and the broker delivers it with `mode: "ping"`.
 * The payload is a task id or an exact task title, read from `text`, then `subject`.
 */
export const PING_MODE = "ping" as const;

/** Interval at which a session sends pings (`/loop 5m`). */
export const PING_INTERVAL_MS = 5 * 60 * 1000;

/** How long one ping keeps a task shown as running; each ping resets it. */
export const PING_TTL_MS = 5 * 60 * 1000;

/** Broker message as bantou sees a ping. */
export interface PingMessage {
  mode: typeof PING_MODE;
  text?: string;
  subject?: string;
}

/** Task id / title a ping refers to: `text` first, then `subject`. */
export function pingSubject(msg: Pick<PingMessage, "text" | "subject">): string | undefined {
  const text = msg.text?.trim();
  if (text) return text;
  const subject = msg.subject?.trim();
  return subject ? subject : undefined;
}

// -- reply from bantou --------------------------------------------------------

/** Heading of the user's answer in the reply text. */
export const REPLY_ANSWER_HEADING = "【ユーザー回答（原文）】";

/** Heading of the bantou responder's instruction in the reply text. */
export const REPLY_INSTRUCTION_HEADING = "【bantou 指示】";

/**
 * Reply text sent to the asking peer (`from_name` of the `ask`):
 *
 *     【ユーザー回答（原文）】
 *     <answer>
 *
 *     【bantou 指示】
 *     <instruction>
 */
export function formatReply(answer: string, instruction: string): string {
  return `${REPLY_ANSWER_HEADING}\n${answer}\n\n${REPLY_INSTRUCTION_HEADING}\n${instruction}`;
}
