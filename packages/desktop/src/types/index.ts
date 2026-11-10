/** Mirror of `src-tauri/src/task.rs::Task`. */
export interface Task {
  /** frontmatter `id` (stable across title renames). Empty when absent. */
  id: string;
  /** Absolute path of the `.md` file. */
  path: string;
  title: string;
  status: string;
  order: number | null;
  /** Session names. */
  tags: string[];
  date: string | null;
  body: string;
}

export interface AskOption {
  label: string;
  description: string;
}

/** Mirror of `src-tauri/src/thread.rs::TimelineEntry`. */
export interface TimelineEntry {
  role: "session" | "bantou" | "user" | "system";
  text: string;
  at: string;
}

/** Mirror of `src-tauri/src/thread.rs::Thread`. */
export interface Thread {
  task_id: string;
  status: "waiting" | "answered";
  request: {
    from_name: string;
    from_id: string;
    question: string;
    options: AskOption[];
    received_at: string;
  };
  timeline: TimelineEntry[];
  agent_session_id: string | null;
  answer: string | null;
}

/** Mirror of `src-tauri/src/broker.rs::BrokerStatus`. */
export interface BrokerStatus {
  connected: boolean;
  peer_id: string | null;
  broker_url: string;
  name: string;
  error: string | null;
}

/** Mirror of `src-tauri/src/broker.rs::Ping`. */
export interface Ping {
  task_id: string;
  /** RFC3339. */
  expires_at: string;
}

export interface AgentEvent {
  workspace: string;
  task_id: string;
  state: "busy" | "idle" | "exited" | "error";
  message: string | null;
}

/** Context usage of a session's claude (center `contextUsage`; mirror of `src-tauri/src/session.rs::ContextUsage`). */
export interface ContextUsage {
  usedTokens: number;
  /** null: the center cannot tell the model's window (then `percent` is null too). */
  windowTokens: number | null;
  percent: number | null;
  updatedAt: string | null;
}

/** A session of the center's `session_list` (mirror of `src-tauri/src/session.rs::Session`). */
export interface Session {
  name: string;
  state: CenterSession["state"] | null;
  sessionUrl: string | null;
  source: CenterSession["source"] | null;
  lastError: string | null;
  /** The folder the session runs in (on the center's host). null: the center sent none. */
  path: string | null;
  /** null: the center has none (not known yet, or an older center). */
  contextUsage: ContextUsage | null;
  /** The session was started with the session instructions (the text itself is not sent). */
  instructions: boolean;
  /** The center's work state (`unknown`/null: show nothing). Mirror of `session_list` `activity`. */
  activity: "working" | "needs-input" | "idle" | "unknown" | null;
  /** When `activity` last changed (ISO string). null: none. */
  activityAt: string | null;
  /** Work left on remote-caps (`session_list` `remote`). null: the center sent none (older center). */
  remote: { running: number; waitingReply: number } | null;
  /** The claude's auth state (null: an older center that does not report it). */
  auth: CenterAuthState | null;
  loginUrl: string | null;
  loginError: string | null;
}

/** The work state shown on the side menu (`unknown` is not shown). */
export type SessionActivity = "working" | "needs-input" | "idle" | "remote-working";

/** What the add dialog needs for the folder field (mirror of `session.rs::PathHints`). */
export interface SessionPathHints {
  /** The center's default parent folder (`<workspace>/<name>` is the default path). null: unknown / not set / an older center. */
  workspace: string | null;
  /** This PC's folder dialog applies (own sidecar center, macOS / Windows). */
  canPick: boolean;
}

/**
 * Project (= session) settings kept by the center (`settings` of `session_settings_get`). `instructions`,
 * `addDirs`, `outputStyle`, `servers` and `memory`; the center keeps items this desktop does not know and returns them as they are.
 * In an update, `null` removes an item.
 */
export interface ProjectSettings {
  /** Appended to master-cap's system prompt (`claude --append-system-prompt`). */
  instructions?: string | null;
  /** Folders master-cap may read and edit besides its own (`claude --add-dir`, one per entry; absolute paths on the center's host). */
  addDirs?: string[] | null;
  /** The body (markdown) of claude's output style: the center writes it into the session's folder and selects it with `--settings`. A session's value replaces the center-wide one. */
  outputStyle?: string | null;
  /** Servers the session may use (host names or server_ids). Absent / null = all (or the center-wide value); `[]` = none. */
  servers?: string[] | null;
  /**
   * External memory (an MCP endpoint). In an update the object replaces the stored one: an omitted `token` keeps the
   * stored token and "" removes it. The center never returns the token: it answers `tokenSet` instead.
   */
  memory?: { url: string; token?: string; agentId?: string; tokenSet?: boolean } | null;
}

/** The center's list as last fetched (mirror of `src-tauri/src/session.rs::SessionList`). Memory only. */
export interface SessionList {
  sessions: Session[];
  /** false: the center could not be asked at the latest read; `sessions` is the older list. */
  reachable: boolean;
  /** Why the center could not be asked (`reachable` false). */
  reason: string | null;
  /** Counts the changes of the Rust-side cache; the highest one wins (see `useBoard`). */
  rev: number;
}

/** Mirror of `src-tauri/src/center.rs::CenterSettings`. */
export interface CenterSettings {
  enabled: boolean;
  port: number;
  /** The IP the connection settings name as the URL host (the center itself listens on every address). */
  bind: string;
  /** The one workspace directory (default `~/.bantou`). */
  workspace: string;
  claudePath?: string;
  /** Bearer token the sidecar center requires on /mcp. Minted by the backend when empty. */
  token: string;
  /** Center on another host, taken from a pasted connection snippet (used instead of the sidecar). */
  remote?: CenterRemote;
}

/** Mirror of `src-tauri/src/center.rs::CenterRemote`. */
export interface CenterRemote {
  url: string;
  /** Unset: the snippet had no token (the center answers 401). */
  token?: string;
}

/** Mirror of `src-tauri/src/center_snippet.rs::ConnectSnippets`. */
export interface CenterConnectSnippets {
  url: string;
  mcpJson: string;
  claudeCode: string;
}

/** Mirror of `src-tauri/src/center_snippet.rs::ParsedConnect`. */
export interface CenterParsedConnect {
  url: string;
  token?: string;
}

/** Mirror of `src-tauri/src/center.rs::CenterStatus`. */
export interface CenterStatus {
  state: "stopped" | "running" | "restarting" | "error";
  pid?: number;
  error?: string;
  /** Automatic restarts since the last user-driven start. */
  restartCount: number;
  /** Reason of the last unintended exit (exit code / signal). */
  lastExit?: string;
  /** The center could not listen (judged from its log). */
  bindFailed: boolean;
  logs: string[];
}

/** Mirror of `src-tauri/src/center_snippet.rs::IpStatus`. */
export interface CenterIpStatus {
  /** This machine's addresses now. */
  ips: string[];
  /** The saved IP; unset when none is saved. */
  saved?: string;
  /** External IPv4 (LAN first), else 127.0.0.1. */
  defaultIp: string;
  /** The saved IP is not an address of this machine now. */
  missing: boolean;
}

/** Mirror of `src-tauri/src/center_mcp.rs::CenterConnection`. */
export interface CenterConnection {
  /** MCP endpoint in use. Unset: no target (center disabled and no remote). */
  url?: string;
  source?: "remote" | "sidecar";
  connected: boolean;
  lastError?: string;
}

/** MCP `tools/call` result as returned by `center_call`. */
export interface McpToolResult {
  content: { type: string; text?: string }[];
  isError?: boolean;
}

/** `rc_list` entry (`packages/center` `RcStatus`, the part shown). */
export interface CenterRcStatus {
  project: string;
  path: string;
  state: "stopped" | "starting" | "connected" | "error";
  pid: number | null;
  sessionUrl: string | null;
  restarts: number;
  lastError?: string;
}

/** `server_list` entry (`packages/center` `ServerInfo`). */
export interface CenterServerInfo {
  name: string;
  connected: boolean;
  reachable: boolean;
  peerId: string | null;
  serverPeer: string | null;
  /** What the link last heard from its server (hello_result / status_result). Absent when not learned yet or an old server. */
  server_id?: string;
  host?: string;
  user?: string;
  workspace?: string;
}

export interface CenterAgentState {
  kind: "cap" | "worker";
  id: string;
  state: string;
  [key: string]: unknown;
}

/** `server_status` result (bantou-server `status_result`, the part shown). */
export interface CenterServerStatus {
  ok?: boolean;
  caps: CenterAgentState[];
  workers: CenterAgentState[];
}

/** State of one server in `server_peers` (center `FollowState`). */
export type CenterFollowState = "ok" | "unsupported" | "updating" | "mismatch" | "failed" | "lost" | "unknown";

/** One server of `server_peers` (center `FollowEntry`): its version against the one paired with this build. */
export interface CenterServerPeer {
  key: string;
  /** Current messenger peer id (changes when the server re-registers). The stable identity is `server_id`. */
  id: string;
  name: string;
  hostname?: string;
  /** Stable id the server reports (protocol 1.7.0, still sent by 1.8.0). Absent for an older server. */
  server_id?: string;
  /** Host name the server reports (shown first), with `user` / `workspace` to tell apart servers on the same host. */
  host?: string;
  user?: string;
  workspace?: string;
  server_version?: string;
  protocol_version?: string;
  state: CenterFollowState;
  /** One-line reason to show. */
  detail: string;
  /** While updating: the target version and how many caps / workers are being waited for. */
  update?: { to: string; running?: { caps: number; workers: number; reports: number } };
  since: string;
}

/** `server_retire` result (center `RetireOutcome`): what the retired server stopped and what an operator does on the host. */
export interface CenterRetireResult {
  ok: true;
  /** retiring = the server accepted; already_retiring = it was already retiring. */
  state: "retiring" | "already_retiring";
  server_id: string;
  host?: string;
  user?: string;
  workspace?: string;
  peer: string;
  /** Not present for already_retiring. */
  stopped?: { caps: number; workers: number };
  exit_at?: string;
  exit_code?: number;
  /** Shell lines for root on the host: remove the service unit, the OS user, the workspace. */
  host_steps?: string[];
  service?: { manager: "systemd" | "launchd" | "none"; name?: string; detected?: boolean };
  /** How many cap records (session x server) the center dropped. */
  records_removed: number;
  sessions: string[];
  message: string;
}

/** `server_peers` result: the versions paired with this build (npm `bantou` and protocol `bantou`) and each server's state. */
export interface CenterServerPeers {
  pair: { server: string | null; protocol: string };
  peers: CenterServerPeer[];
}

/** `activity.agents[].state` of `remote_list` (bantou-server `ActivityState`). */
export type CenterActivityState = "running" | "stalled" | "idle" | "done" | "failed" | "lost";

/** One cap / worker of `remote_list` `activity.agents` (bantou-server `AgentActivity`). */
export interface CenterAgentActivity {
  kind: "cap" | "worker";
  id: string;
  cap_id: string;
  state: CenterActivityState;
  task: string;
  last_activity: string | null;
  last_output_at: string | null;
  /** ms since the last output as of the center's reply (shown with the time elapsed since the fetch). */
  silent_ms: number;
  started_at: string | null;
  finished_at: string | null;
  error?: string;
  /** Model the agent runs with (`--model`). null / absent = none given (or a server that does not report it). */
  model?: string | null;
}

/** `remote_list[].activity` (center `RemoteActivity`). Omitted until the first notice arrives. */
export interface CenterRemoteActivity {
  at: string;
  received_ms_ago: number;
  /** running / stalled agents exist but notices stopped arriving (server or path may be down). */
  stale: boolean;
  agents: CenterAgentActivity[];
}

/** A pending (not yet completed) instruction of a remote-cap (center `PendingInstruction`). Removed once completed; no history is kept. */
export interface CenterPendingInstruction {
  at: string;
  /** Session that sent the instruction (the one notified on completion). */
  owner: string;
  /** Head of the prompt (at most 200 characters). */
  prompt: string;
}

/** One worker in `task_result` (protocol `TaskResultWorker`). */
export interface CenterTaskResultWorker {
  worker_id: string;
  role: string;
  state: CenterActivityState;
  branch?: string;
  commit?: string;
  tests?: string;
  report_path?: string;
  /** Head of the worker's result (at most 500 chars). */
  result: string;
}

export interface CenterReviewItem {
  severity: "high" | "medium" | "low";
  text: string;
  resolved: boolean;
}

/** `remote_list[].task_result` (protocol `TaskResultReply`, the part shown). */
export interface CenterTaskResult {
  cap_id: string;
  task_id: string;
  state: "done" | "failed";
  summary: string;
  workers: CenterTaskResultWorker[];
  review: { verdict: "ok" | "issues" | "unknown"; items: CenterReviewItem[]; rounds: number };
  remaining: string[];
  error?: string;
}

/** `remote_list[].worker_reports` element (protocol `WorkerReportNotice`): latest 20, in arrival order. */
export interface CenterWorkerReport {
  cap_id: string;
  task_id?: string;
  worker_id: string;
  kind: "progress" | "ask" | "approve" | "done";
  text: string;
  at: string;
}

/**
 * `remote_list` element (center `RemoteView`, the part shown): one remote-cap per session × server (`remote_id` = cap_id = `c-<center-id>-<session>`),
 * with the latest result / error and the pending instructions. No history is kept; old-format records (one cap per task) are cleaned up by center.
 */
export interface CenterRemoteRecord {
  remote_id: string;
  /** Session (master-cap) that owns this cap. Absent = the old shared cap (`c-<center-id>`) kept from before: no new instruction is sent, `remote_delete` removes it. */
  session?: string;
  /** Sessions with a pending instruction on this cap (oldest first). */
  owners: string[];
  /** `server_id` (an old record whose server_id is unknown keeps the peer id). */
  server: string;
  server_id?: string;
  /** Current reachable peer id; absent after the server was not seen for a long time. */
  peer?: string;
  serverName?: string;
  serverHost?: string;
  serverUser?: string;
  serverWorkspace?: string;
  /** Display label: host name first with the server_id (plus user and workspace when several servers share the host name). */
  server_label?: string;
  state: "running" | "done" | "failed" | "unknown";
  /** Model given when the cap was created (absent = none). */
  model?: string;
  worker_model?: string;
  createdAt: string;
  finishedAt?: string;
  /** Latest `cap_result` text. */
  result?: string;
  result_at?: string;
  error?: string;
  error_at?: string;
  pending?: CenterPendingInstruction[];
  activity?: CenterRemoteActivity;
  /** Latest `task_result` of the cap (absent until a `task` finished). */
  task_result?: CenterTaskResult;
  /** Latest worker reports (at most 20, arrival order). */
  worker_reports?: CenterWorkerReport[];
}

/** State machine of the in-app updater (`useUpdater`). Mirrors Cork's `UpdaterState`. */
export type UpdaterState =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "latest" }
  | { kind: "available"; update: import("@tauri-apps/plugin-updater").Update; version: string }
  | { kind: "downloading"; version: string; downloaded: number; contentLength: number | null }
  | { kind: "installing"; version: string }
  | { kind: "error"; message: string; version: string | null };

/**
 * The claude's auth state as the center reads it from the pty (`packages/center` `AuthState`):
 * `login_required` = `Please run /login` was shown (OAuth token expired), `keychain_locked` = the login could not be
 * saved (`Couldn't save your login`, the host's keychain is locked).
 */
export type CenterAuthState = "ok" | "login_required" | "keychain_locked";

/** `session_list` / `session_create` entry (`packages/center` `SessionInfo`, the part shown). */
export interface CenterSession {
  name: string;
  state: "stopped" | "starting" | "connected" | "error";
  sessionUrl: string | null;
  source: "config" | "session";
  lastError?: string;
  contextUsage?: ContextUsage | null;
  instructions?: boolean;
  auth: CenterAuthState;
  loginUrl: string | null;
  loginError: string | null;
}

/** `session_login` result: the URL the user opens in a browser to get the code. */
export interface CenterLoginStart {
  name: string;
  loginUrl: string;
}

/** `session_login_code` result. `error`: `Invalid code` or `Couldn't save your login` (keychain locked). */
export interface CenterLoginCode {
  name: string;
  ok: boolean;
  auth: CenterAuthState;
  error: string | null;
}
