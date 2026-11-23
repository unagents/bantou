/**
 * bantou protocol v2 messages. Spec of record: messenger/PROTOCOL.md (schemas: messenger/protocol.json).
 * One JSON object goes in the messenger message text. The sender attaches `meta = MESSENGER_PROTOCOL`
 * ({ protocol: "bantou", version }). The destination is a center or a server only; the body never names a server or a worker.
 */

/** Body field `protocol`, always "bantou". */
export const PROTOCOL_NAME = "bantou" as const;

/** `callType` values. `exec` is accepted as a callType but has no defined `order` (a message with it is ignored). */
export type CallType = "invoke" | "reply" | "status" | "exec";

export interface MessageBase {
  protocol: typeof PROTOCOL_NAME;
  callType: CallType;
  order: string;
}

/** center -> server: start a worker for the cap `parent-id`. */
export interface LaunchMessage extends MessageBase {
  callType: "invoke";
  order: "launch";
  /** Name of the cap. Non-empty. */
  "parent-id": string;
  /** Model of the worker (MODEL_PATTERN). */
  model: string;
  /** The work to do. Non-empty. */
  prompt: string;
  /** Destination of the center's ws. Non-empty. */
  ws: string;
}

/** center -> server: stop the workers of the cap `parent-id`. */
export interface StopMessage extends MessageBase {
  callType: "invoke";
  order: "stop";
  /** Name of the cap. Non-empty. */
  "parent-id": string;
}

/** center -> server: the answer to a worker's question. */
export interface AnswerMessage extends MessageBase {
  callType: "reply";
  order: "answer";
  /** Non-empty. */
  "session-id": string;
  /** The answer text (may be empty). */
  content: string;
}

/** center -> server: approve what the worker asked to do. */
export interface ApproveMessage extends MessageBase {
  callType: "reply";
  order: "approve";
  /** Non-empty. */
  "session-id": string;
}

/** center -> server: reject what the worker asked to do. */
export interface RejectMessage extends MessageBase {
  callType: "reply";
  order: "reject";
  /** Non-empty. */
  "session-id": string;
}

/** center -> server: ask for the server's version. The server answers with ServerInfoReply. */
export interface ServerInfoMessage extends MessageBase {
  callType: "status";
  order: "server-info";
}

/** server -> the sender of server-info: the npm `bantou` version of the running server. */
export interface ServerInfoReply extends MessageBase {
  callType: "status";
  order: "server-info";
  /** x.y.z */
  version: string;
}

/** Messages a server receives (center -> server). */
export type ServerMessage =
  | LaunchMessage
  | StopMessage
  | AnswerMessage
  | ApproveMessage
  | RejectMessage
  | ServerInfoMessage;

/** All 7 messages of the protocol. */
export type BantouMessage = ServerMessage | ServerInfoReply;

// -- ping ---------------------------------------------------------------------

/**
 * `ping` is not a JSON message. The session calls the messenger `send_ping`
 * tool and the broker delivers it with `mode: "ping"`.
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

// -- reply text ---------------------------------------------------------------

/** Heading of the user's answer in the reply text. */
export const REPLY_ANSWER_HEADING = "【ユーザー回答（原文）】";

/** Heading of the bantou responder's instruction in the reply text. */
export const REPLY_INSTRUCTION_HEADING = "【bantou 指示】";

/**
 * Reply text sent to the asking peer:
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
