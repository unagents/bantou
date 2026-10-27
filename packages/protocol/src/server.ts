/**
 * Commands to bantou-server and its replies.
 * One JSON object goes in the messenger `send_message` text, `to = "bantou-server"`.
 */
import { PROTOCOL_VERSION } from "./envelope.js";

/** Messenger peer name of bantou-server. */
export const SERVER_NAME = "bantou-server";

/** Allowed session names (`name` of launch_session; also the tmux session name). */
export const SESSION_NAME_PATTERN = /^[A-Za-z0-9_-]+$/;

export type ServerCommandType = "launch_session" | "list_sessions";

export interface ServerCommandBase {
  /** Protocol version, always 1. */
  bantou: typeof PROTOCOL_VERSION;
  type: ServerCommandType;
}

/** Start a claude session in tmux on the server host. */
export interface LaunchSessionCommand extends ServerCommandBase {
  type: "launch_session";
  /** Session name = tmux session name. SESSION_NAME_PATTERN. */
  name: string;
  /** Git URL. When given, cloned to `<workspace>/repos/<name>` (fetch only if it exists). */
  repo?: string;
  /** Branch for `git clone --branch`. */
  branch?: string;
  /** Working directory relative to `<workspace>/repos/`. Defaults to `<name>`. */
  cwd?: string;
}

/** List tmux sessions on the server host. */
export interface ListSessionsCommand extends ServerCommandBase {
  type: "list_sessions";
}

export type ServerCommand = LaunchSessionCommand | ListSessionsCommand;

export type ServerReplyType = "session_launched" | "sessions" | "error";

export interface SessionLaunchedReply {
  bantou: typeof PROTOCOL_VERSION;
  type: "session_launched";
  ok: true;
  name: string;
  /** tmux session name (same as name). */
  tmux: string;
  /** Absolute working directory of the session. */
  cwd: string;
}

export interface SessionInfo {
  name: string;
  windows: number;
  /** ISO 8601 creation time. */
  created: string;
  attached: boolean;
}

export interface SessionsReply {
  bantou: typeof PROTOCOL_VERSION;
  type: "sessions";
  ok: true;
  sessions: SessionInfo[];
}

export interface ErrorReply {
  bantou: typeof PROTOCOL_VERSION;
  type: "error";
  ok: false;
  message: string;
  /** `type` of the command that failed, when known. */
  command?: ServerCommandType;
}

export type ServerReply = SessionLaunchedReply | SessionsReply | ErrorReply;

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

function isCommandType(v: unknown): v is ServerCommandType {
  return v === "launch_session" || v === "list_sessions";
}

/** A string matching SESSION_NAME_PATTERN. */
export function isValidSessionName(name: unknown): name is string {
  return typeof name === "string" && SESSION_NAME_PATTERN.test(name);
}

export function isServerCommand(v: unknown): v is ServerCommand {
  if (!isRecord(v) || v.bantou !== PROTOCOL_VERSION) return false;
  if (v.type === "launch_session") {
    return (
      isValidSessionName(v.name) &&
      optNonEmptyString(v.repo) &&
      optNonEmptyString(v.branch) &&
      optNonEmptyString(v.cwd)
    );
  }
  return v.type === "list_sessions";
}

export function isLaunchSessionCommand(v: unknown): v is LaunchSessionCommand {
  return isServerCommand(v) && v.type === "launch_session";
}

export function isListSessionsCommand(v: unknown): v is ListSessionsCommand {
  return isServerCommand(v) && v.type === "list_sessions";
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

function isSessionInfo(v: unknown): v is SessionInfo {
  return (
    isRecord(v) &&
    typeof v.name === "string" &&
    typeof v.windows === "number" &&
    typeof v.created === "string" &&
    typeof v.attached === "boolean"
  );
}

export function isServerReply(v: unknown): v is ServerReply {
  if (!isRecord(v) || v.bantou !== PROTOCOL_VERSION) return false;
  switch (v.type) {
    case "session_launched":
      return (
        v.ok === true &&
        typeof v.name === "string" &&
        typeof v.tmux === "string" &&
        typeof v.cwd === "string"
      );
    case "sessions":
      return v.ok === true && Array.isArray(v.sessions) && v.sessions.every(isSessionInfo);
    case "error":
      return (
        v.ok === false &&
        typeof v.message === "string" &&
        (v.command === undefined || isCommandType(v.command))
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
