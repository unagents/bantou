/**
 * Commands to bantou-server and its replies.
 * One JSON object goes in the messenger `send_message` text, `to = "bantou-server"`.
 */
import { PROTOCOL_VERSION } from "./envelope.js";

/** Messenger peer name of bantou-server. */
export const SERVER_NAME = "bantou-server";

/**
 * agent-messenger protocol registration (messenger/protocol.json) used in `meta` of send / listPeers.
 * Not the body schema version (`bantou: 1`, PROTOCOL_VERSION). Keep in sync with messenger/protocol.json.
 */
export const MESSENGER_PROTOCOL = { protocol: "bantou", version: "1.0.0" } as const;

/** Allowed cap / worker ids (also directory names under <workspace>/caps and <workspace>/workers). */
export const AGENT_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

export type AgentKind = "cap" | "worker";

/** Lifecycle of one cap / worker as kept in its state.json. */
export type AgentState = "idle" | "running" | "failed" | "error";

export type ServerCommandType = "kick_cap" | "resume_worker" | "status";

export interface ServerCommandBase {
  /** Protocol version, always 1. */
  bantou: typeof PROTOCOL_VERSION;
  type: ServerCommandType;
}

/** Start or resume the remote cap `cap_id` headlessly with `prompt`. */
export interface KickCapCommand extends ServerCommandBase {
  type: "kick_cap";
  /** AGENT_ID_PATTERN. */
  cap_id: string;
  /** Git URL; cloned into the cap path on first use, fetched afterwards. */
  repo?: string;
  /** Branch for `git clone --branch`. */
  branch?: string;
  /** Non-empty. */
  prompt: string;
  /** Free text, logged only. */
  reason?: string;
}

/** Resume (or start) the worker `worker_id` with `prompt`. */
export interface ResumeWorkerCommand extends ServerCommandBase {
  type: "resume_worker";
  /** AGENT_ID_PATTERN. */
  worker_id: string;
  repo?: string;
  branch?: string;
  /** Non-empty. */
  prompt: string;
}

/** List caps and workers with their state. */
export interface StatusCommand extends ServerCommandBase {
  type: "status";
}

export type ServerCommand = KickCapCommand | ResumeWorkerCommand | StatusCommand;

export type ServerReplyType = "cap_result" | "worker_result" | "status_result" | "error";

/** Outcome of one headless run. */
export interface RunOutcome {
  /** Claude session id used (new or resumed). */
  session_id: string;
  ok: boolean;
  /** Final `result` text of the run; "" when it failed before producing one. */
  result_text: string;
  /** Failure detail when ok is false. */
  error?: string;
}

export interface CapResultReply extends RunOutcome {
  bantou: typeof PROTOCOL_VERSION;
  type: "cap_result";
  cap_id: string;
}

export interface WorkerResultReply extends RunOutcome {
  bantou: typeof PROTOCOL_VERSION;
  type: "worker_result";
  worker_id: string;
}

export interface AgentStatus {
  kind: AgentKind;
  id: string;
  /** Absolute directory. */
  path: string;
  session_id: string | null;
  state: AgentState;
  /** ISO 8601. */
  last_started_at: string | null;
  /** ISO 8601. */
  last_finished_at: string | null;
  last_error?: string;
  retries: number;
  /** Commands waiting in this agent's queue (the running one excluded). */
  queued: number;
}

export interface StatusReply {
  bantou: typeof PROTOCOL_VERSION;
  type: "status_result";
  ok: true;
  caps: AgentStatus[];
  workers: AgentStatus[];
}

export interface ErrorReply {
  bantou: typeof PROTOCOL_VERSION;
  type: "error";
  ok: false;
  message: string;
  /** `type` of the command that failed, when known. */
  command?: ServerCommandType;
  /** `cap_id` of the failed `kick_cap`, when known. */
  cap_id?: string;
  /** `worker_id` of the failed `resume_worker`, when known. */
  worker_id?: string;
}

export type ServerReply = CapResultReply | WorkerResultReply | StatusReply | ErrorReply;

// -- guards -------------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Absent, or a non-empty string that does not start with `-` and has no NUL. */
function optNonEmptyString(v: unknown): boolean {
  return (
    v === undefined ||
    (typeof v === "string" && v.length > 0 && !v.startsWith("-") && !v.includes("\0"))
  );
}

function optString(v: unknown): boolean {
  return v === undefined || typeof v === "string";
}

/** Absent, or a string without NUL. */
function optPlainString(v: unknown): boolean {
  return v === undefined || (typeof v === "string" && !v.includes("\0"));
}

/** A non-empty string without NUL. */
function nonEmptyString(v: unknown): boolean {
  return typeof v === "string" && v.length > 0 && !v.includes("\0");
}

function strOrNull(v: unknown): boolean {
  return v === null || typeof v === "string";
}

function isCommandType(v: unknown): v is ServerCommandType {
  return v === "kick_cap" || v === "resume_worker" || v === "status";
}

/** A string matching AGENT_ID_PATTERN. */
export function isValidAgentId(v: unknown): v is string {
  return typeof v === "string" && AGENT_ID_PATTERN.test(v);
}

export function isAgentState(v: unknown): v is AgentState {
  return v === "idle" || v === "running" || v === "failed" || v === "error";
}

export function isServerCommand(v: unknown): v is ServerCommand {
  if (!isRecord(v) || v.bantou !== PROTOCOL_VERSION) return false;
  switch (v.type) {
    case "kick_cap":
      return (
        isValidAgentId(v.cap_id) &&
        nonEmptyString(v.prompt) &&
        optNonEmptyString(v.repo) &&
        optNonEmptyString(v.branch) &&
        optPlainString(v.reason)
      );
    case "resume_worker":
      return (
        isValidAgentId(v.worker_id) &&
        nonEmptyString(v.prompt) &&
        optNonEmptyString(v.repo) &&
        optNonEmptyString(v.branch)
      );
    case "status":
      return true;
    default:
      return false;
  }
}

export function isKickCapCommand(v: unknown): v is KickCapCommand {
  return isServerCommand(v) && v.type === "kick_cap";
}

export function isResumeWorkerCommand(v: unknown): v is ResumeWorkerCommand {
  return isServerCommand(v) && v.type === "resume_worker";
}

export function isStatusCommand(v: unknown): v is StatusCommand {
  return isServerCommand(v) && v.type === "status";
}

/** Parse message text as a server command; `undefined` for non-JSON or non-command. */
export function parseServerCommand(text: string): ServerCommand | undefined {
  try {
    const v: unknown = JSON.parse(text.trim());
    return isServerCommand(v) ? v : undefined;
  } catch {
    return undefined;
  }
}

function isRunOutcome(v: Record<string, unknown>): boolean {
  return (
    typeof v.session_id === "string" &&
    typeof v.ok === "boolean" &&
    typeof v.result_text === "string" &&
    optString(v.error)
  );
}

function isAgentStatus(v: unknown): v is AgentStatus {
  return (
    isRecord(v) &&
    (v.kind === "cap" || v.kind === "worker") &&
    typeof v.id === "string" &&
    typeof v.path === "string" &&
    strOrNull(v.session_id) &&
    isAgentState(v.state) &&
    strOrNull(v.last_started_at) &&
    strOrNull(v.last_finished_at) &&
    optString(v.last_error) &&
    typeof v.retries === "number" &&
    typeof v.queued === "number"
  );
}

export function isServerReply(v: unknown): v is ServerReply {
  if (!isRecord(v) || v.bantou !== PROTOCOL_VERSION) return false;
  switch (v.type) {
    case "cap_result":
      return isValidAgentId(v.cap_id) && isRunOutcome(v);
    case "worker_result":
      return isValidAgentId(v.worker_id) && isRunOutcome(v);
    case "status_result":
      return (
        v.ok === true &&
        Array.isArray(v.caps) &&
        v.caps.every(isAgentStatus) &&
        Array.isArray(v.workers) &&
        v.workers.every(isAgentStatus)
      );
    case "error":
      return (
        v.ok === false &&
        typeof v.message === "string" &&
        (v.command === undefined || isCommandType(v.command)) &&
        (v.cap_id === undefined || isValidAgentId(v.cap_id)) &&
        (v.worker_id === undefined || isValidAgentId(v.worker_id))
      );
    default:
      return false;
  }
}

/** Parse message text as a server reply; `undefined` for non-JSON or non-reply. */
export function parseServerReply(text: string): ServerReply | undefined {
  try {
    const v: unknown = JSON.parse(text.trim());
    return isServerReply(v) ? v : undefined;
  } catch {
    return undefined;
  }
}
