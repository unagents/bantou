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
export const MESSENGER_PROTOCOL = { protocol: "bantou", version: "1.3.0" } as const;

/**
 * hello / update_server (and their replies) exist from this protocol version. A server older than this
 * ignores them, so a center must not send them there. Their shape is fixed for good: they are the only way
 * to update a server whose protocol version differs from the center's.
 */
export const FOLLOW_MIN_PROTOCOL = "1.3.0";

/** Version string accepted by update_server (semver; never starts with '-', it ends up in an npx argument). */
export const SERVER_VERSION_PATTERN = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

/** Allowed cap / worker ids (also directory names under <workspace>/caps and <workspace>/workers). */
export const AGENT_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

export type AgentKind = "cap" | "worker";

/** Lifecycle of one cap / worker as kept in its state.json. */
export type AgentState = "idle" | "running" | "failed" | "error";

export type ServerCommandType = "kick_cap" | "resume_worker" | "stop_cap" | "status" | "hello" | "update_server";

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

/**
 * Stop the running remote cap `cap_id` (its `claude -p` process group). Reply: stop_result, or error.
 * The interrupted kick_cap still gets its own cap_result with ok=false.
 */
export interface StopCapCommand extends ServerCommandBase {
  type: "stop_cap";
  /** AGENT_ID_PATTERN. */
  cap_id: string;
}

/** List caps and workers with their state. */
export interface StatusCommand extends ServerCommandBase {
  type: "status";
}

/** Ask the server for its own version and update state. Reply: hello_result. Accepted whatever the sender's protocol version is. */
export interface HelloCommand extends ServerCommandBase {
  type: "hello";
}

/**
 * Tell the server to update itself to npm `bantou@<version>` and restart once every running cap / worker is done.
 * Reply: update_result, or error. The package source is the server's own config, never this message.
 */
export interface UpdateServerCommand extends ServerCommandBase {
  type: "update_server";
  /** SERVER_VERSION_PATTERN. */
  version: string;
}

export type ServerCommand =
  | KickCapCommand
  | ResumeWorkerCommand
  | StopCapCommand
  | StatusCommand
  | HelloCommand
  | UpdateServerCommand;

export type ServerReplyType =
  | "cap_result"
  | "worker_result"
  | "stop_result"
  | "status_result"
  | "hello_result"
  | "update_result"
  | "error";

/** Runs still alive on the server. An update waits until all of them are 0. */
export interface UpdateRunning {
  caps: number;
  workers: number;
  reports: number;
}

/** An update in progress. waiting = refusing kick_cap until the runs end; restarting = shutting down for the swap. */
export interface UpdateProgress {
  state: "waiting" | "restarting";
  from: string;
  to: string;
  running: UpdateRunning;
}

/** The last update that failed (kept by the server until the next attempt). */
export interface UpdateFailure {
  to: string;
  ok: false;
  error: string;
  /** ISO 8601. */
  at: string;
}

/** Reply to hello. */
export interface HelloResultReply {
  bantou: typeof PROTOCOL_VERSION;
  type: "hello_result";
  ok: true;
  /** npm `bantou` version of the running server. */
  server_version: string;
  /** Registered messenger protocol version of the running server. */
  protocol_version: string;
  update: UpdateProgress | null;
  last_update: UpdateFailure | null;
}

/** Reply to update_server. state "current" = already running that version. */
export interface UpdateResultReply {
  bantou: typeof PROTOCOL_VERSION;
  type: "update_result";
  ok: true;
  state: "current" | "waiting" | "restarting";
  from: string;
  to: string;
  running: UpdateRunning;
}

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

/** Outcome of stop_cap. */
export interface StopResultReply {
  bantou: typeof PROTOCOL_VERSION;
  type: "stop_result";
  ok: true;
  cap_id: string;
  /** true when a running (or about to start) run was found and stopped; false when the cap was not running. */
  stopped: boolean;
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
  /** Machine-readable cause, when there is one. */
  code?: ErrorCode;
  /** true when the same command may be sent again later. */
  retryable?: boolean;
}

/**
 * updating = server is waiting to restart for an update (retryable);
 * update_failed = the version could not be fetched; update_conflict = another update is in progress;
 * invalid_version = bad version string; version_mismatch = refused by a center because the protocol versions differ.
 */
export type ErrorCode = "updating" | "update_failed" | "update_conflict" | "invalid_version" | "version_mismatch";

export const ERROR_CODES: readonly ErrorCode[] = ["updating", "update_failed", "update_conflict", "invalid_version", "version_mismatch"];

export type ServerReply =
  | CapResultReply
  | WorkerResultReply
  | StopResultReply
  | StatusReply
  | HelloResultReply
  | UpdateResultReply
  | ErrorReply;

/** Liveness of one cap / worker as seen from its `claude -p` stream-json output. */
export type ActivityState = "running" | "stalled" | "idle" | "done" | "failed" | "lost";

export const ACTIVITY_STATES: readonly ActivityState[] = ["running", "stalled", "idle", "done", "failed", "lost"];

/** Summary of one cap / worker run. Never carries the full output. */
export interface AgentActivity {
  kind: AgentKind;
  id: string;
  /** The cap itself for a cap, the owning cap for a worker. */
  cap_id: string;
  state: ActivityState;
  /** Head of the last kick_cap / worker_start prompt (one line, at most 200 chars). */
  task: string;
  /** Short summary of the latest activity (at most 120 chars); null when there is none yet. */
  last_activity: string | null;
  /** When the last stdout line arrived (server clock, ISO 8601). */
  last_output_at: string | null;
  /** Milliseconds since the last output (or started_at) at send time. Use this, not clock differences, to show elapsed time. */
  silent_ms: number;
  started_at: string | null;
  finished_at: string | null;
  /** Why the agent is failed / lost (at most 200 chars). */
  error?: string;
}

/** Notice from server to center (not a reply: it is never matched with a pending command). */
export interface ActivityNotice {
  bantou: typeof PROTOCOL_VERSION;
  type: "activity";
  cap_id: string;
  /** Send time (server clock, ISO 8601). */
  at: string;
  /** The cap first, then its workers by id. */
  agents: AgentActivity[];
}

export type ServerNotice = ActivityNotice;

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
  return (
    v === "kick_cap" ||
    v === "resume_worker" ||
    v === "stop_cap" ||
    v === "status" ||
    v === "hello" ||
    v === "update_server"
  );
}

/** A string matching SERVER_VERSION_PATTERN. */
export function isValidServerVersion(v: unknown): v is string {
  return typeof v === "string" && SERVER_VERSION_PATTERN.test(v);
}

export function isErrorCode(v: unknown): v is ErrorCode {
  return typeof v === "string" && (ERROR_CODES as readonly string[]).includes(v);
}

function isUpdateRunning(v: unknown): v is UpdateRunning {
  return isRecord(v) && typeof v.caps === "number" && typeof v.workers === "number" && typeof v.reports === "number";
}

function isUpdateProgress(v: unknown): v is UpdateProgress {
  return (
    isRecord(v) &&
    (v.state === "waiting" || v.state === "restarting") &&
    typeof v.from === "string" &&
    typeof v.to === "string" &&
    isUpdateRunning(v.running)
  );
}

function isUpdateFailure(v: unknown): v is UpdateFailure {
  return isRecord(v) && typeof v.to === "string" && v.ok === false && typeof v.error === "string" && typeof v.at === "string";
}

/** A string matching AGENT_ID_PATTERN. */
export function isValidAgentId(v: unknown): v is string {
  return typeof v === "string" && AGENT_ID_PATTERN.test(v);
}

export function isAgentState(v: unknown): v is AgentState {
  return v === "idle" || v === "running" || v === "failed" || v === "error";
}

export function isActivityState(v: unknown): v is ActivityState {
  return typeof v === "string" && (ACTIVITY_STATES as readonly string[]).includes(v);
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
    case "stop_cap":
      return isValidAgentId(v.cap_id);
    case "status":
    case "hello":
      return true;
    case "update_server":
      return isValidServerVersion(v.version);
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

export function isStopCapCommand(v: unknown): v is StopCapCommand {
  return isServerCommand(v) && v.type === "stop_cap";
}

export function isStatusCommand(v: unknown): v is StatusCommand {
  return isServerCommand(v) && v.type === "status";
}

export function isHelloCommand(v: unknown): v is HelloCommand {
  return isServerCommand(v) && v.type === "hello";
}

export function isUpdateServerCommand(v: unknown): v is UpdateServerCommand {
  return isServerCommand(v) && v.type === "update_server";
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
    case "stop_result":
      return v.ok === true && isValidAgentId(v.cap_id) && typeof v.stopped === "boolean";
    case "status_result":
      return (
        v.ok === true &&
        Array.isArray(v.caps) &&
        v.caps.every(isAgentStatus) &&
        Array.isArray(v.workers) &&
        v.workers.every(isAgentStatus)
      );
    case "hello_result":
      return (
        v.ok === true &&
        typeof v.server_version === "string" &&
        typeof v.protocol_version === "string" &&
        (v.update === null || isUpdateProgress(v.update)) &&
        (v.last_update === null || isUpdateFailure(v.last_update))
      );
    case "update_result":
      return (
        v.ok === true &&
        (v.state === "current" || v.state === "waiting" || v.state === "restarting") &&
        typeof v.from === "string" &&
        typeof v.to === "string" &&
        isUpdateRunning(v.running)
      );
    case "error":
      return (
        v.ok === false &&
        typeof v.message === "string" &&
        (v.command === undefined || isCommandType(v.command)) &&
        (v.cap_id === undefined || isValidAgentId(v.cap_id)) &&
        (v.worker_id === undefined || isValidAgentId(v.worker_id)) &&
        (v.code === undefined || isErrorCode(v.code)) &&
        (v.retryable === undefined || typeof v.retryable === "boolean")
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

function isAgentActivity(v: unknown): v is AgentActivity {
  return (
    isRecord(v) &&
    (v.kind === "cap" || v.kind === "worker") &&
    isValidAgentId(v.id) &&
    isValidAgentId(v.cap_id) &&
    isActivityState(v.state) &&
    typeof v.task === "string" &&
    strOrNull(v.last_activity) &&
    strOrNull(v.last_output_at) &&
    typeof v.silent_ms === "number" &&
    strOrNull(v.started_at) &&
    strOrNull(v.finished_at) &&
    optString(v.error)
  );
}

export function isServerNotice(v: unknown): v is ServerNotice {
  if (!isRecord(v) || v.bantou !== PROTOCOL_VERSION) return false;
  return (
    v.type === "activity" &&
    isValidAgentId(v.cap_id) &&
    typeof v.at === "string" &&
    Array.isArray(v.agents) &&
    v.agents.every(isAgentActivity)
  );
}

/** Parse message text as a server notice; `undefined` for non-JSON or non-notice. */
export function parseServerNotice(text: string): ServerNotice | undefined {
  try {
    const v: unknown = JSON.parse(text.trim());
    return isServerNotice(v) ? v : undefined;
  } catch {
    return undefined;
  }
}
