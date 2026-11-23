// The GraphQL documents of the screens and the small conversions between the schema's answers and the screens' types
// (`packages/ui/types`). Pure (no Tauri / Nuxt import), so it is tested on its own. Document names follow
// docs/design/center-graphql-server.md 3.1 / 3.2; fields follow packages/center/src/graphql/schema-*.ts.

import type { CenterRcStatus, CenterServer, ProjectSettings, Session, SessionRemote } from "../types";

// -- fields ---------------------------------------------------------------------------------------------

const ISSUE = "server remoteId lastOkAt at kind taskId detail";

export const SESSION_FIELDS = `name state sessionUrl source lastError path
  contextUsage { usedTokens windowTokens percent updatedAt }
  instructions activity activityAt background { subagents tasks }
  remote { running waitingReply unreachable { ${ISSUE} } lost { ${ISSUE} } stopped { ${ISSUE} } }
  auth loginUrl loginError sleeping`;

const SETTINGS_FIELDS = "instructions addDirs outputStyle servers mcpServers memory projectMemory mcp mcpConnections mcpSecrets coordinator";

// -- query / mutation documents ---------------------------------------------------------------------------

export const Q_SESSIONS = `query Sessions { sessions { reachable reason sessions { ${SESSION_FIELDS} } } }`;
export const Q_SESSION_SETTINGS = `query SessionSettings($name: String!) { sessionSettings(name: $name) { ${SETTINGS_FIELDS} } }`;
const CENTER_SETTINGS_FIELDS = "instructions addDirs outputStyle guardrailSchemas openspecUrl mcpServers memory projectMemory mcp mcpConnections mcpSecrets coordinator";

export const Q_CENTER_INFO = "query CenterInfo { centerInfo { workspace } }";
export const Q_CENTER_LAUNCHER = "query CenterLauncher { centerInfo { launcher } }";
export const Q_CENTER_SETTINGS = `query CenterSettings { centerSettings { ${CENTER_SETTINGS_FIELDS} } centerInfo { launcher } }`;
export const M_UPDATE_CENTER_SETTINGS = `mutation UpdateCenterSettings($settings: CenterSettingsInput!) { updateCenterSettings(settings: $settings) { ${CENTER_SETTINGS_FIELDS} } }`;
export const Q_REMOTES = "query Remotes { remotes { remote_id session server state model createdAt finishedAt } }";
export const Q_REMOTES_SERVERS = "query Servers { servers { name host protocol lastSeen } }";
export const Q_RC_STATUS = "query RcStatus { rcStatus { project path state pid sessionUrl restarts lastError } }";

export const M_CREATE_SESSION = `mutation CreateSession($name: String!, $path: String, $settings: ProjectSettingsInput) { createSession(name: $name, path: $path, settings: $settings) { ${SESSION_FIELDS} } }`;
export const M_UPDATE_SESSION = `mutation UpdateSession($name: String!, $newName: String, $path: String, $move: Boolean) { updateSession(name: $name, newName: $newName, path: $path, move: $move) { ${SESSION_FIELDS} } }`;
export const M_SLEEP_SESSION = "mutation SleepSession($name: String!) { sleepSession(name: $name) { name state accepted sleeping pending } }";
export const M_WAKE_SESSION = `mutation WakeSession($name: String!) { wakeSession(name: $name) { ${SESSION_FIELDS} } }`;
export const M_UPDATE_SESSION_SETTINGS = `mutation UpdateSessionSettings($name: String!, $settings: ProjectSettingsInput!) { updateSessionSettings(name: $name, settings: $settings) { ${SETTINGS_FIELDS} } }`;
export const M_START_SESSION_LOGIN = "mutation StartSessionLogin($name: String!) { startSessionLogin(name: $name) { name loginUrl } }";
export const M_SUBMIT_SESSION_LOGIN_CODE = "mutation SubmitSessionLoginCode($name: String!, $code: String!) { submitSessionLoginCode(name: $name, code: $code) { name ok auth error } }";
export const M_RESTART_SESSION = "mutation RestartSession($name: String!) { restartSession(name: $name) }";
export const M_TERMINAL_INPUT = "mutation TerminalInput($session: String!, $dataB64: String!) { terminalInput(session: $session, dataB64: $dataB64) }";
export const M_TERMINAL_RESIZE = "mutation TerminalResize($session: String!, $cols: Int!, $rows: Int!) { terminalResize(session: $session, cols: $cols, rows: $rows) }";
export const M_ATTACH_TO_SESSION = "mutation AttachToSession($session: String!, $type: String!, $dataB64: String!) { attachToSession(session: $session, type: $type, dataB64: $dataB64) { path bytes } }";

// -- subscription documents ---------------------------------------------------------------------------------

export const S_SESSIONS_CHANGED = "subscription SessionsChanged { sessionsChanged { reason name } }";
export const S_SESSION_MESSAGE = "subscription SessionMessage { sessionMessage { session text at } }";
export const S_TERMINAL_OUTPUT = "subscription TerminalOutput($session: String!, $after: Int) { terminalOutput(session: $session, after: $after) { type id data status } }";

// -- answers -> screen types ------------------------------------------------------------------------------

/** The schema answers `null` for what is not set; the screens' settings types leave it out (in an update `null` means remove). */
export function dropNulls<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null)) as T;
}

export interface GqlSession extends Omit<Session, "activity" | "remote"> {
  activity: "working" | "needs_input" | "idle" | "unknown" | null;
  remote: {
    running: number;
    waitingReply: number;
    unreachable: Record<string, unknown>[] | null;
    lost: Record<string, unknown>[] | null;
    stopped: Record<string, unknown>[] | null;
  } | null;
}

/** The screens write `needs-input`; a GraphQL enum value cannot hold a `-` (center `resolvers/enums.ts`). */
export function toSession(g: GqlSession): Session {
  const r = g.remote;
  const remote: SessionRemote | null = r
    ? {
        running: r.running,
        waitingReply: r.waitingReply,
        // absent (not null) when there is none: the screens test `?.length`
        ...(r.unreachable ? { unreachable: r.unreachable.map(issue) } : {}),
        ...(r.lost ? { lost: r.lost.map(issue) } : {}),
        ...(r.stopped ? { stopped: r.stopped.map(issue) } : {}),
      }
    : null;
  return { ...g, activity: g.activity === "needs_input" ? "needs-input" : g.activity, remote } as Session;
}

// `lastOkAt` is allowed to be null in the screens' type (none answered yet); the others are absent when not sent
function issue(i: Record<string, unknown>): never {
  const { lastOkAt, ...rest } = i;
  return { ...dropNulls(rest), ...(lastOkAt === undefined ? {} : { lastOkAt }) } as never;
}

export const toSettings = (g: ProjectSettings): ProjectSettings => dropNulls(g);

export function toServer(g: { name: string; host: string | null; protocol: string | null; lastSeen: string | null }): CenterServer {
  return { name: g.name, host: g.host, protocol: g.protocol, last_seen: g.lastSeen };
}

/** `lastError` is optional in the screens' type (`pid` / `sessionUrl` are already nullable there). */
export function toRc(g: Omit<CenterRcStatus, "lastError"> & { lastError: string | null }): CenterRcStatus {
  const { lastError, ...rest } = g;
  return lastError === null ? rest : { ...rest, lastError };
}
