import { PROTOCOL_NAME } from "./envelope.js";
import type {
  AnswerMessage,
  ApproveMessage,
  BantouMessage,
  LaunchMessage,
  RejectMessage,
  SchemaDiscovery,
  ServerInfoMessage,
  ServerInfoReply,
  ServerMessage,
  StopMessage,
} from "./envelope.js";
import { isValidModel } from "./server.js";

/** Version string of server-info's answer: x.y.z. */
export const SERVER_VERSION_PATTERN = /^\d+\.\d+\.\d+$/;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** A non-empty string without NUL. */
function nonEmpty(v: unknown): v is string {
  return typeof v === "string" && v.length > 0 && !v.includes("\0");
}

function isBase(v: Record<string, unknown>, callType: string, order: string): boolean {
  return v.protocol === PROTOCOL_NAME && v.callType === callType && v.order === order;
}

/** The `schema` of launch: { type: "http", url, headers: { Authorization } }. Other keys are allowed. */
export function isSchemaDiscovery(v: unknown): v is SchemaDiscovery {
  return (
    isRecord(v) &&
    v.type === "http" &&
    nonEmpty(v.url) &&
    isRecord(v.headers) &&
    nonEmpty(v.headers.Authorization)
  );
}

export function isLaunchMessage(v: unknown): v is LaunchMessage {
  return (
    isRecord(v) &&
    isBase(v, "invoke", "launch") &&
    nonEmpty(v["parent-id"]) &&
    (v.model === undefined || isValidModel(v.model)) &&
    nonEmpty(v.prompt) &&
    nonEmpty(v.ws) &&
    (v.schema === undefined || isSchemaDiscovery(v.schema))
  );
}

export function isStopMessage(v: unknown): v is StopMessage {
  return isRecord(v) && isBase(v, "invoke", "stop") && nonEmpty(v["parent-id"]);
}

export function isAnswerMessage(v: unknown): v is AnswerMessage {
  return (
    isRecord(v) &&
    isBase(v, "reply", "answer") &&
    nonEmpty(v["session-id"]) &&
    typeof v.content === "string" &&
    !v.content.includes("\0")
  );
}

export function isApproveMessage(v: unknown): v is ApproveMessage {
  return isRecord(v) && isBase(v, "reply", "approve") && nonEmpty(v["session-id"]);
}

export function isRejectMessage(v: unknown): v is RejectMessage {
  return isRecord(v) && isBase(v, "reply", "reject") && nonEmpty(v["session-id"]);
}

export function isServerInfoMessage(v: unknown): v is ServerInfoMessage {
  return isRecord(v) && isBase(v, "status", "server-info") && v.version === undefined;
}

export function isServerInfoReply(v: unknown): v is ServerInfoReply {
  return (
    isRecord(v) &&
    isBase(v, "status", "server-info") &&
    typeof v.version === "string" &&
    SERVER_VERSION_PATTERN.test(v.version)
  );
}

/** A message a server receives (center -> server). Anything else, including `callType: "exec"`, is not a message: ignore it. */
export function isServerMessage(v: unknown): v is ServerMessage {
  return (
    isLaunchMessage(v) ||
    isStopMessage(v) ||
    isAnswerMessage(v) ||
    isApproveMessage(v) ||
    isRejectMessage(v) ||
    isServerInfoMessage(v)
  );
}

/** Any of the 7 messages. */
export function isBantouMessage(v: unknown): v is BantouMessage {
  return isServerMessage(v) || isServerInfoReply(v);
}

/** Parse message text as a server message; `undefined` for non-JSON or anything that is not one of the 6. */
export function parseServerMessage(text: string): ServerMessage | undefined {
  try {
    const v: unknown = JSON.parse(text.trim());
    return isServerMessage(v) ? v : undefined;
  } catch {
    return undefined;
  }
}

/** Parse message text as server-info's answer; `undefined` for non-JSON or anything else. */
export function parseServerInfoReply(text: string): ServerInfoReply | undefined {
  try {
    const v: unknown = JSON.parse(text.trim());
    return isServerInfoReply(v) ? v : undefined;
  } catch {
    return undefined;
  }
}
