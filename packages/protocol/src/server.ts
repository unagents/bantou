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
export const MESSENGER_PROTOCOL = { protocol: "bantou", version: "1.8.1" } as const;

/**
 * retire_server / retire_result exist from this protocol version. A server older than this ignores retire_server
 * (an unknown command gets no reply), so a center must not send it there and must never read "no reply" as "retired".
 * retire_server is a control command like update_server: a server accepts it whatever the sender's protocol version is.
 */
export const RETIRE_MIN_PROTOCOL = "1.8.0";

/**
 * Exit code a retired server leaves with (supervisor child -> server.exit -> launcher -> process).
 * systemd: RestartPreventExitStatus lists it, so the unit is not restarted.
 */
export const RETIRE_EXIT_CODE = 76;

/** Does a server that declares protocol `version` understand retire_server? Unknown / malformed version = false. */
export function supportsRetire(version: string | undefined): boolean {
  if (typeof version !== "string") return false;
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  const min = /^(\d+)\.(\d+)\.(\d+)/.exec(RETIRE_MIN_PROTOCOL);
  if (!m || !min) return false;
  for (let i = 1; i <= 3; i++) {
    const d = Number(m[i]) - Number(min[i]);
    if (d !== 0) return d > 0;
  }
  return true;
}

/**
 * hello / update_server (and their replies) exist from this protocol version. A server older than this
 * ignores them, so a center must not send them there. Their shape is fixed for good: they are the only way
 * to update a server whose protocol version differs from the center's.
 */
export const FOLLOW_MIN_PROTOCOL = "1.3.0";

/** Version string accepted by update_server (semver; never starts with '-', it ends up in an npx argument). */
export const SERVER_VERSION_PATTERN = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

/**
 * Allowed server_id (stable id of one server, generated once per workspace; e.g. `srv-0a1b2c3d4e`).
 * Same character set as AGENT_ID_PATTERN, at most 64 chars.
 */
export const SERVER_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** Allowed cap / worker ids (also directory names under <workspace>/caps and <workspace>/workers). */
export const AGENT_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

/**
 * Claude model name passed as-is to `claude --model` ("sonnet", "opus", "claude-sonnet-5-5", "opus[1m]" ...).
 * Optional everywhere; absent = no `--model` (the claude default). Never starts with '-' (it ends up in an argument).
 */
export const MODEL_PATTERN = /^[A-Za-z0-9._\[\]][A-Za-z0-9._\[\]-]*$/;

export type AgentKind = "cap" | "worker";

/** Lifecycle of one cap / worker as kept in its state.json. */
export type AgentState = "idle" | "running" | "failed" | "error";

export type ServerCommandType =
  | "kick_cap"
  | "resume_worker"
  | "stop_cap"
  | "status"
  | "hello"
  | "update_server"
  | "task"
  | "worker_reply"
  | "retire_server";

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
  /** MODEL_PATTERN. Model of the cap's own `claude -p` (`--model`). Absent = no `--model`. Servers older than 1.4.0 ignore it. */
  model?: string;
  /** MODEL_PATTERN. Default model of the workers this cap starts (used when `worker_start` has no `model`). The server remembers it as the cap's default. */
  worker_model?: string;
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
 * Close the remote cap `cap_id`: stop its running `claude -p` process group (if any) and discard its conversation
 * (the session_id in state.json), so the next task starts a new conversation. Works whether the cap is idle, failed or
 * running. The cap's logs/ (raw output, reports.jsonl) are kept. Reply: stop_result, or error.
 * The interrupted kick_cap still gets its own cap_result with ok=false.
 */
export interface StopCapCommand extends ServerCommandBase {
  type: "stop_cap";
  /** AGENT_ID_PATTERN. */
  cap_id: string;
}

/**
 * List caps and workers with their state. Reply: status_result.
 * With `cap_id` the server also takes the sender as the center to notify for that cap (activity / cap_result /
 * task_result / worker_report go to the sender's name). A center sends it after a restart to take the notices back.
 * Protocol 1.6.0; a server older than that ignores `cap_id`.
 */
export interface StatusCommand extends ServerCommandBase {
  type: "status";
  /** AGENT_ID_PATTERN. Optional. */
  cap_id?: string;
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

/** Role of a worker in a task. */
export type WorkerRole = "implement" | "review" | "docs" | "test" | "other";

export const WORKER_ROLES: readonly WorkerRole[] = ["implement", "review", "docs", "test", "other"];

/** Deliverables the task asks for. All fields optional. */
export interface TaskDeliverables {
  /** Branch the workers push to. Must not start with '-'. */
  branch?: string;
  /** Where the workers put their reports (a path in the clone, or free text). */
  report_path?: string;
  /** Other deliverables, one per entry. */
  other?: string[];
}

/** How to check the result. All fields optional. */
export interface TaskVerify {
  /** Test commands to run. */
  tests?: string[];
  /** Check procedure, one step per entry. */
  steps?: string[];
}

/** One planned worker. */
export interface TaskWorkerItem {
  /** Name other items refer to in depends_on. AGENT_ID_PATTERN. */
  id?: string;
  role: WorkerRole;
  /** What this worker covers (non-empty). */
  scope: string;
  /** MODEL_PATTERN. Absent = worker_model of the task, else the cap's default. */
  model?: string;
  /** `id` of the items that must finish before this one starts. */
  depends_on?: string[];
}

/**
 * Worker split. No items = the default: at least 2 workers, one implement and one review.
 * items = the center's own split; the cap follows it.
 */
export interface TaskWorkers {
  items?: TaskWorkerItem[];
}

/**
 * Give the remote cap `cap_id` a task. The server builds the cap's first instruction from the fields
 * (prompts.ts buildTaskPrompt; text in docs/design/cap-orchestration.md). The same cap_id again resumes the cap.
 * Reply: task_result, or error. Protocol 1.5.0.
 */
export interface TaskCommand extends ServerCommandBase {
  type: "task";
  /** AGENT_ID_PATTERN. */
  cap_id: string;
  /** TASK_ID_PATTERN (same characters as AGENT_ID_PATTERN). Echoed in task_result and worker_report. */
  task_id: string;
  /** Natural-language goal. Non-empty. */
  goal: string;
  /** Git URL the work is based on. Relayed to the cap in the prompt; the cap path is never cloned (workers clone). */
  repo?: string;
  /** Base branch of the work. Relayed like `repo`. */
  branch?: string;
  deliverables: TaskDeliverables;
  verify: TaskVerify;
  /** Constraints, one per entry (may be empty). */
  constraints: string[];
  workers: TaskWorkers;
  /** MODEL_PATTERN. Default model of the workers (same as kick_cap `worker_model`). */
  worker_model?: string;
}

/**
 * Send `text` to the worker `worker_id` of the cap `cap_id`: the server runs worker_start with the same worker_id.
 * Reply: worker_reply_result, or error. Protocol 1.5.0.
 */
export interface WorkerReplyCommand extends ServerCommandBase {
  type: "worker_reply";
  /** AGENT_ID_PATTERN. The cap that owns the worker. */
  cap_id: string;
  /** AGENT_ID_PATTERN. */
  worker_id: string;
  /** Non-empty. */
  text: string;
}

/**
 * Retire the server: refuse new work, stop every cap / worker, unregister from the messenger, release the host lock and
 * exit (supervisor and launcher with it; exit code RETIRE_EXIT_CODE so the OS service manager does not restart it).
 * Reply: retire_result (sent before the server goes away), or error. Irreversible: the server writes
 * <workspace>/server.retired and refuses to start again until that file is removed. Protocol 1.8.0.
 * A server older than 1.8.0 ignores it without a reply (see RETIRE_MIN_PROTOCOL / supportsRetire).
 */
export interface RetireServerCommand extends ServerCommandBase {
  type: "retire_server";
  /** SERVER_ID_PATTERN. Optional. When given and different from the server's own server_id the server refuses (error, nothing is stopped). Peer names are all `bantou-server`, so a center should send it. */
  server_id?: string;
  /** Free text, logged and written to server.retired. */
  reason?: string;
}

export type ServerCommand =
  | RetireServerCommand
  | KickCapCommand
  | ResumeWorkerCommand
  | StopCapCommand
  | StatusCommand
  | HelloCommand
  | UpdateServerCommand
  | TaskCommand
  | WorkerReplyCommand;

export type ServerReplyType =
  | "cap_result"
  | "worker_result"
  | "stop_result"
  | "status_result"
  | "hello_result"
  | "update_result"
  | "task_result"
  | "worker_reply_result"
  | "retire_result"
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
export interface HelloResultReply extends ServerIdentityFields {
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

/** One worker in a task_result. */
export interface TaskResultWorker {
  /** AGENT_ID_PATTERN. */
  worker_id: string;
  role: WorkerRole;
  state: ActivityState;
  /** Branch the worker pushed to. */
  branch?: string;
  /** Last commit of the worker. */
  commit?: string;
  /** Tests the worker ran and their outcome (free text, e.g. `npm test: 41 pass`). */
  tests?: string;
  report_path?: string;
  /** Head of the worker's result (at most 500 chars). */
  result: string;
}

export type ReviewVerdict = "ok" | "issues" | "unknown";

export const REVIEW_VERDICTS: readonly ReviewVerdict[] = ["ok", "issues", "unknown"];

export type ReviewSeverity = "high" | "medium" | "low";

export const REVIEW_SEVERITIES: readonly ReviewSeverity[] = ["high", "medium", "low"];

export interface ReviewItem {
  severity: ReviewSeverity;
  text: string;
  /** true when the implementer fixed it and the reviewer confirmed. */
  resolved: boolean;
}

/** Outcome of the review (implement <-> review rounds). verdict "unknown" = no review result could be read. */
export interface TaskReview {
  verdict: ReviewVerdict;
  items: ReviewItem[];
  /** Number of implement <-> review round trips done (0 = none). */
  rounds: number;
}

/**
 * Reply to `task`. The server takes it from the cap's final answer (a JSON object, see CAP_GUIDE).
 * When it cannot read one: `summary` = the raw answer, `workers` and `remaining` empty, `review.verdict` "unknown".
 */
export interface TaskResultReply {
  bantou: typeof PROTOCOL_VERSION;
  type: "task_result";
  cap_id: string;
  task_id: string;
  /** done = the run ended normally; failed = it did not (see `error`). */
  state: "done" | "failed";
  summary: string;
  workers: TaskResultWorker[];
  review: TaskReview;
  /** What is left undone or unresolved, one per entry. */
  remaining: string[];
  /** Failure detail when state is failed. */
  error?: string;
}

/** Reply to worker_reply: the worker was started (resumed) with the text. */
export interface WorkerReplyResultReply {
  bantou: typeof PROTOCOL_VERSION;
  type: "worker_reply_result";
  ok: true;
  cap_id: string;
  worker_id: string;
  accepted: true;
}

/** What the server stopped for a retire. */
export interface RetireStopped {
  caps: number;
  workers: number;
}

/** How the server is run by the OS, as far as the server can tell from its own process. */
export interface RetireService {
  /** systemd / launchd = started by that manager; none = started by hand. */
  manager: "systemd" | "launchd" | "none";
  /** Unit name (systemd) or label (launchd). Absent for `none`. */
  name?: string;
  /** true = read from the running process (systemd cgroup / launchd env); false = the install-service.sh default name, not confirmed. */
  detected?: boolean;
}

/**
 * Reply to retire_server. The server is retiring: it exits shortly after sending this (exit_at), so the next
 * message from it is its disappearance. Sending retire_server again meanwhile gets the same reply.
 * `host_steps` = what an operator with root does on the host afterwards (the server cannot: it runs as an unprivileged user).
 */
export interface RetireResultReply extends ServerIdentityFields {
  bantou: typeof PROTOCOL_VERSION;
  type: "retire_result";
  ok: true;
  state: "retiring";
  /** Runs that were stopped (caps and workers that were running). */
  stopped: RetireStopped;
  /** ISO 8601. When the server starts to exit (after the reply has had time to be pulled). */
  exit_at: string;
  /** Exit code the server leaves with (RETIRE_EXIT_CODE). */
  exit_code: number;
  /** 1..3 shell lines: remove the service unit, the OS user, the workspace. Values are shell-quoted. */
  host_steps: string[];
  service?: RetireService;
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
  /**
   * true when the server discarded the cap's conversation (state.json session_id -> null). false when there was nothing
   * to discard (no such cap, or no session yet). Absent = the server only stops (it does not discard the conversation):
   * a center must not read absence as "discarded".
   */
  session_cleared?: boolean;
  /** The session_id that was discarded (null / absent when there was none). Servers that send session_cleared send this too. */
  previous_session_id?: string | null;
}

/**
 * Size and health of the conversation (one claude session) of a cap or worker. All fields are what the server could read
 * from claude's own output; a field it could not read is null / absent. Optional in AgentStatus (additive; no version bump).
 */
export interface ConversationInfo {
  /** ISO 8601. When the current conversation (session) started. */
  started_at: string | null;
  /** Number of runs (claude -p invocations that reached claude: task, kick_cap, report resume) in this conversation. */
  tasks: number;
  /** Tokens in the context at the last answer that reported usage: input + cache creation + cache read (claude's own figure; output excluded). */
  context_tokens: number | null;
  /** contextWindow claude reported for the main model. */
  context_window: number | null;
  /** context_tokens / context_window in percent (one decimal). null when either is unknown. */
  context_percent: number | null;
  /** ISO 8601. When context_tokens was read. */
  usage_at: string | null;
  /** Error text taken from claude's own output of the last failed run (e.g. "Prompt is too long"). Absent when the last run did not fail with one. */
  last_error_text?: string;
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
  /** Model the agent was started with (`--model`); null / absent = none given. Servers older than 1.4.0 omit it. */
  model?: string | null;
  /** Conversation size / health (additive; absent on servers that do not send it). */
  conversation?: ConversationInfo;
}

/**
 * Who a server is (protocol 1.7.0). All fields optional in a reply: a server older than 1.7.0 sends none of them,
 * and a center then falls back to the messenger peer id. Carried flat in hello_result and status_result.
 */
export interface ServerIdentityFields {
  /** SERVER_ID_PATTERN. Stable across restarts / self-updates of the same workspace; kept in <workspace>/server.json. */
  server_id?: string;
  /** os.hostname() of the machine the server runs on. */
  host?: string;
  /** OS user the server runs as. */
  user?: string;
  /** Absolute workspace path of the server. */
  workspace?: string;
}

export interface StatusReply extends ServerIdentityFields {
  bantou: typeof PROTOCOL_VERSION;
  type: "status_result";
  ok: true;
  /** npm `bantou` version of the running server (same as hello_result.server_version). Protocol 1.7.0. */
  server_version?: string;
  /** Registered messenger protocol version of the running server. Protocol 1.7.0. */
  protocol_version?: string;
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
  /** `worker_id` of the failed `resume_worker` / `worker_reply`, when known. */
  worker_id?: string;
  /** `task_id` of the failed `task`, when known. */
  task_id?: string;
  /** Machine-readable cause, when there is one. */
  code?: ErrorCode;
  /** true when the same command may be sent again later. */
  retryable?: boolean;
  /** true = the server is retiring (retire_server accepted) and refuses this command for good. Protocol 1.8.0; an older center ignores it. */
  retiring?: true;
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
  | TaskResultReply
  | WorkerReplyResultReply
  | RetireResultReply
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
  /** Model the agent runs with (`--model`); null / absent = none given. Servers older than 1.4.0 omit it. */
  model?: string | null;
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

export type WorkerReportKind = "progress" | "ask" | "approve" | "done";

export const WORKER_REPORT_KINDS: readonly WorkerReportKind[] = ["progress", "ask", "approve", "done"];

/**
 * Notice from server to center: a worker called its report tool. Sent for every report, in parallel with
 * the resume of the cap. Protocol 1.5.0.
 */
export interface WorkerReportNotice {
  bantou: typeof PROTOCOL_VERSION;
  type: "worker_report";
  cap_id: string;
  /** task_id of the latest `task` of the cap; absent when the cap has had no `task` (only kick_cap). */
  task_id?: string;
  worker_id: string;
  kind: WorkerReportKind;
  /** The report text as the worker sent it (1..20000 chars). */
  text: string;
  /** Receive time (server clock, ISO 8601). */
  at: string;
}

export type ServerNotice = ActivityNotice | WorkerReportNotice;

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
    v === "update_server" ||
    v === "task" ||
    v === "worker_reply" ||
    v === "retire_server"
  );
}

/** Absent, or an array whose entries are all strings without NUL. */
function optPlainStrings(v: unknown): boolean {
  return v === undefined || (Array.isArray(v) && v.every((x) => typeof x === "string" && !x.includes("\0")));
}

export function isWorkerRole(v: unknown): v is WorkerRole {
  return typeof v === "string" && (WORKER_ROLES as readonly string[]).includes(v);
}

export function isWorkerReportKind(v: unknown): v is WorkerReportKind {
  return typeof v === "string" && (WORKER_REPORT_KINDS as readonly string[]).includes(v);
}

function isTaskWorkerItem(v: unknown): v is TaskWorkerItem {
  return (
    isRecord(v) &&
    (v.id === undefined || isValidAgentId(v.id)) &&
    isWorkerRole(v.role) &&
    nonEmptyString(v.scope) &&
    optModel(v.model) &&
    (v.depends_on === undefined || (Array.isArray(v.depends_on) && v.depends_on.every(isValidAgentId)))
  );
}

function isTaskCommandBody(v: Record<string, unknown>): boolean {
  const d = v.deliverables;
  const f = v.verify;
  const w = v.workers;
  return (
    isValidAgentId(v.cap_id) &&
    isValidAgentId(v.task_id) &&
    nonEmptyString(v.goal) &&
    optNonEmptyString(v.repo) &&
    optNonEmptyString(v.branch) &&
    isRecord(d) &&
    optNonEmptyString(d.branch) &&
    optPlainString(d.report_path) &&
    optPlainStrings(d.other) &&
    isRecord(f) &&
    optPlainStrings(f.tests) &&
    optPlainStrings(f.steps) &&
    Array.isArray(v.constraints) &&
    optPlainStrings(v.constraints) &&
    isRecord(w) &&
    (w.items === undefined || (Array.isArray(w.items) && w.items.every(isTaskWorkerItem))) &&
    optModel(v.worker_model)
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

/** A string matching MODEL_PATTERN. */
export function isValidModel(v: unknown): v is string {
  return typeof v === "string" && MODEL_PATTERN.test(v);
}

/** Absent, or a valid model. */
function optModel(v: unknown): boolean {
  return v === undefined || isValidModel(v);
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
        optPlainString(v.reason) &&
        optModel(v.model) &&
        optModel(v.worker_model)
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
      return v.cap_id === undefined || isValidAgentId(v.cap_id);
    case "hello":
      return true;
    case "update_server":
      return isValidServerVersion(v.version);
    case "task":
      return isTaskCommandBody(v);
    case "worker_reply":
      return isValidAgentId(v.cap_id) && isValidAgentId(v.worker_id) && nonEmptyString(v.text);
    case "retire_server":
      return (v.server_id === undefined || (typeof v.server_id === "string" && SERVER_ID_PATTERN.test(v.server_id))) && optPlainString(v.reason);
    default:
      return false;
  }
}

export function isRetireServerCommand(v: unknown): v is RetireServerCommand {
  return isServerCommand(v) && v.type === "retire_server";
}

export function isTaskCommand(v: unknown): v is TaskCommand {
  return isServerCommand(v) && v.type === "task";
}

export function isWorkerReplyCommand(v: unknown): v is WorkerReplyCommand {
  return isServerCommand(v) && v.type === "worker_reply";
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

/** Optional identity fields of hello_result / status_result: absent (older server) or well-formed. */
function isServerIdentity(v: Record<string, unknown>): boolean {
  return (
    (v.server_id === undefined || (typeof v.server_id === "string" && SERVER_ID_PATTERN.test(v.server_id))) &&
    optString(v.host) &&
    optString(v.user) &&
    optString(v.workspace)
  );
}

function isCount(v: unknown): boolean {
  return typeof v === "number" && Number.isInteger(v) && v >= 0;
}

function isRetireService(v: unknown): v is RetireService {
  return (
    isRecord(v) &&
    (v.manager === "systemd" || v.manager === "launchd" || v.manager === "none") &&
    optString(v.name) &&
    (v.detected === undefined || typeof v.detected === "boolean")
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
    typeof v.queued === "number" &&
    (v.model === undefined || strOrNull(v.model)) &&
    (v.conversation === undefined || isConversationInfo(v.conversation))
  );
}

function numOrNull(v: unknown): boolean {
  return v === null || (typeof v === "number" && Number.isFinite(v));
}

function isConversationInfo(v: unknown): v is ConversationInfo {
  return (
    isRecord(v) &&
    strOrNull(v.started_at) &&
    isCount(v.tasks) &&
    numOrNull(v.context_tokens) &&
    numOrNull(v.context_window) &&
    numOrNull(v.context_percent) &&
    strOrNull(v.usage_at) &&
    optString(v.last_error_text)
  );
}

function isTaskResultWorker(v: unknown): v is TaskResultWorker {
  return (
    isRecord(v) &&
    isValidAgentId(v.worker_id) &&
    isWorkerRole(v.role) &&
    isActivityState(v.state) &&
    optString(v.branch) &&
    optString(v.commit) &&
    optString(v.tests) &&
    optString(v.report_path) &&
    typeof v.result === "string"
  );
}

function isReviewItem(v: unknown): v is ReviewItem {
  return (
    isRecord(v) &&
    typeof v.severity === "string" &&
    (REVIEW_SEVERITIES as readonly string[]).includes(v.severity) &&
    typeof v.text === "string" &&
    typeof v.resolved === "boolean"
  );
}

function isTaskReview(v: unknown): v is TaskReview {
  return (
    isRecord(v) &&
    typeof v.verdict === "string" &&
    (REVIEW_VERDICTS as readonly string[]).includes(v.verdict) &&
    Array.isArray(v.items) &&
    v.items.every(isReviewItem) &&
    typeof v.rounds === "number" &&
    Number.isInteger(v.rounds) &&
    v.rounds >= 0
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
      return (
        v.ok === true &&
        isValidAgentId(v.cap_id) &&
        typeof v.stopped === "boolean" &&
        (v.session_cleared === undefined || typeof v.session_cleared === "boolean") &&
        (v.previous_session_id === undefined || strOrNull(v.previous_session_id))
      );
    case "status_result":
      return (
        v.ok === true &&
        isServerIdentity(v) &&
        optString(v.server_version) &&
        optString(v.protocol_version) &&
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
        isServerIdentity(v) &&
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
    case "task_result":
      return (
        isValidAgentId(v.cap_id) &&
        isValidAgentId(v.task_id) &&
        (v.state === "done" || v.state === "failed") &&
        typeof v.summary === "string" &&
        Array.isArray(v.workers) &&
        v.workers.every(isTaskResultWorker) &&
        isTaskReview(v.review) &&
        Array.isArray(v.remaining) &&
        v.remaining.every((x) => typeof x === "string") &&
        optString(v.error)
      );
    case "worker_reply_result":
      return v.ok === true && isValidAgentId(v.cap_id) && isValidAgentId(v.worker_id) && v.accepted === true;
    case "retire_result":
      return (
        v.ok === true &&
        v.state === "retiring" &&
        isServerIdentity(v) &&
        isRecord(v.stopped) &&
        isCount(v.stopped.caps) &&
        isCount(v.stopped.workers) &&
        typeof v.exit_at === "string" &&
        typeof v.exit_code === "number" &&
        Number.isInteger(v.exit_code) &&
        Array.isArray(v.host_steps) &&
        v.host_steps.length >= 1 &&
        v.host_steps.length <= 3 &&
        v.host_steps.every((x) => typeof x === "string" && x.length > 0) &&
        (v.service === undefined || isRetireService(v.service))
      );
    case "error":
      return (
        v.ok === false &&
        typeof v.message === "string" &&
        (v.command === undefined || isCommandType(v.command)) &&
        (v.cap_id === undefined || isValidAgentId(v.cap_id)) &&
        (v.worker_id === undefined || isValidAgentId(v.worker_id)) &&
        (v.task_id === undefined || isValidAgentId(v.task_id)) &&
        (v.code === undefined || isErrorCode(v.code)) &&
        (v.retryable === undefined || typeof v.retryable === "boolean") &&
        (v.retiring === undefined || v.retiring === true)
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
    optString(v.error) &&
    (v.model === undefined || strOrNull(v.model))
  );
}

export function isServerNotice(v: unknown): v is ServerNotice {
  if (!isRecord(v) || v.bantou !== PROTOCOL_VERSION) return false;
  if (v.type === "worker_report") {
    return (
      isValidAgentId(v.cap_id) &&
      (v.task_id === undefined || isValidAgentId(v.task_id)) &&
      isValidAgentId(v.worker_id) &&
      isWorkerReportKind(v.kind) &&
      typeof v.text === "string" &&
      typeof v.at === "string"
    );
  }
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
