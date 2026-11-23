import { getPlatform } from "~/tauri";
import type { ProjectSettings, Session, SessionList, SessionPathHints } from "../types";
import { centerConnection } from "./center";
import { graphql } from "./graphql";
import {
  M_CREATE_SESSION,
  M_SLEEP_SESSION,
  M_UPDATE_SESSION,
  M_UPDATE_SESSION_SETTINGS,
  M_WAKE_SESSION,
  Q_CENTER_INFO,
  Q_SESSION_SETTINGS,
  Q_SESSIONS,
  S_SESSION_MESSAGE,
  S_SESSIONS_CHANGED,
  toSession,
  toSettings,
  type GqlSession,
} from "./graphql-docs";

/** The machine woke from sleep (emitted by the Rust side). */
export const OS_WAKE_EVENT = "bantou://os-wake";
/** The own sidecar center was started (it may not be listening yet; emitted by the Rust side). */
export const CENTER_RUNNING_EVENT = "bantou://center-running";
/** A network interface or address changed (emitted by the Rust side). */
export const OS_NETWORK_EVENT = "bantou://os-network-changed";

// -- the session list: the last answer is kept here (the screens read it without asking the center) -----------------

type Listener<T> = (payload: T) => void;

/** A tiny local event source (the list and the stream events are client-side now; nothing comes through `listen`). */
function emitter<T>() {
  const listeners = new Set<Listener<T>>();
  return {
    on(l: Listener<T>): () => void {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    emit(p: T) {
      for (const l of [...listeners]) l(p);
    },
    get size() {
      return listeners.size;
    },
  };
}

let lastList: SessionList = { sessions: [], reachable: true, reason: null, rev: -1 };
let rev = 0;
const listChanged = emitter<SessionList>();

function keep(next: Omit<SessionList, "rev">): SessionList {
  lastList = { ...next, rev: rev++ };
  listChanged.emit(lastList);
  return lastList;
}

/** The center's list as last fetched, without asking the center. */
export const listSessions = (): Promise<SessionList> => Promise.resolve(lastList);

/** The list was read again (`refreshSessions`): the board reads `listSessions()` then. */
export const onSessionListChanged = (handler: () => void): (() => void) => listChanged.on(() => handler());

/** Ask the center for `sessions` again. When it cannot be asked, the last list comes back with `reachable: false`. */
export async function refreshSessions(): Promise<SessionList> {
  try {
    const r = await graphql.request<{ sessions: { reachable: boolean; reason: string | null; sessions: GqlSession[] } }>(Q_SESSIONS);
    return keep({ sessions: r.sessions.sessions.map(toSession), reachable: r.sessions.reachable, reason: r.sessions.reason });
  } catch (e) {
    return keep({ sessions: lastList.sessions, reachable: false, reason: e instanceof Error ? e.message : String(e) });
  }
}

// -- subscriptions (design 3.3): one stream per kind, shared by every listener -----------------------------------------

/** A change of the center's sessions (`sessionsChanged`: reason + session name). `changed` with an empty name is this client's own "read again". */
export interface SessionsChange {
  reason: string;
  name: string;
}

export interface SessionMessage {
  session: string;
  text: string;
  at: string;
}

function sharedStream<T>(open: (emit: (p: T) => void) => () => void) {
  const out = emitter<T>();
  let close: (() => void) | undefined;
  return (handler: Listener<T>): (() => void) => {
    const off = out.on(handler);
    close ??= open(out.emit);
    return () => {
      off();
      if (out.size === 0) {
        close?.();
        close = undefined;
      }
    };
  };
}

/**
 * The center reported a session created / deleted / restored / updated / … (subscription `sessionsChanged`). Nothing is replayed
 * to a new stream, and a change while the stream was down has no event: so every open of the stream (also after a drop) is
 * reported once as `{ reason: "changed", name: "" }` — read the list again.
 */
export const onSessionsChanged = sharedStream<SessionsChange>((emit) =>
  graphql.subscribe<{ sessionsChanged: SessionsChange }>(S_SESSIONS_CHANGED, () => ({}), {
    onNext: (d) => emit(d.sessionsChanged),
    onOpen: () => emit({ reason: "changed", name: "" }),
  }),
);

/** A session's last message of a turn (subscription `sessionMessage`). */
export const onSessionMessage = sharedStream<SessionMessage>((emit) =>
  graphql.subscribe<{ sessionMessage: SessionMessage }>(S_SESSION_MESSAGE, () => ({}), { onNext: (d) => emit(d.sessionMessage) }),
);

// -- mutations / queries ----------------------------------------------------------------------------------------------

/**
 * Create a session on the center (`createSession`). `settings` is the project settings to start with;
 * `path` is the folder on the center's host (blank / omitted: not sent, the center uses `<workspace>/<name>`).
 */
export const createSession = async (name: string, settings?: ProjectSettings, path?: string): Promise<Session> =>
  toSession((await graphql.request<{ createSession: GqlSession }>(M_CREATE_SESSION, { name, path: path?.trim() || null, settings: settings ?? null })).createSession);

/**
 * Rename and / or change the folder of a session on the center (`updateSession`). `move` counts with `path` only:
 * true moves the current folder to the new place, false only makes the new folder. Returns the updated session.
 */
export const updateSession = async (name: string, change: { newName?: string; path?: string; move?: boolean }): Promise<Session> =>
  toSession(
    (
      await graphql.request<{ updateSession: GqlSession }>(M_UPDATE_SESSION, {
        name,
        newName: change.newName?.trim() || null,
        path: change.path?.trim() || null,
        move: change.path?.trim() ? (change.move ?? null) : null,
      })
    ).updateSession,
  );

/** `sleepSession`'s answer: it takes the request and returns at once (`pending`); the sleep itself arrives as `sessionsChanged` (reason `sleep`). */
export interface SleepSessionResult {
  name: string;
  state: string | null;
  accepted: boolean | null;
  sleeping: boolean | null;
  pending: boolean | null;
}

/** Ask the center to put a session to sleep (`sleepSession`). A refusal comes back as an error (the caller shows it). */
export const sleepSession = async (name: string): Promise<SleepSessionResult> =>
  (await graphql.request<{ sleepSession: SleepSessionResult }>(M_SLEEP_SESSION, { name })).sleepSession;

/** Wake a sleeping session (`wakeSession`): its claude starts as a new conversation and the center hands it the sleep handoff. Called when the session is opened. */
export const wakeSession = async (name: string): Promise<Session> =>
  toSession((await graphql.request<{ wakeSession: GqlSession }>(M_WAKE_SESSION, { name })).wakeSession);

/**
 * For the add dialog's folder field: the center's default parent folder (`centerInfo.workspace`) and whether this PC's folder
 * dialog applies (a shell that can pick a folder, and the center is the one it started itself: the folder is on this PC).
 */
export async function sessionPathHints(): Promise<SessionPathHints> {
  const [info, conn] = await Promise.all([
    graphql.request<{ centerInfo: { workspace: string | null } }>(Q_CENTER_INFO),
    centerConnection().catch(() => undefined),
  ]);
  return { workspace: info.centerInfo.workspace, canPick: getPlatform().centerSidecar !== false && conn?.source === "sidecar" };
}

/** The project settings of a session, kept by the center (`sessionSettings`). `{}` when none. */
export const getSessionSettings = async (name: string): Promise<ProjectSettings> =>
  toSettings((await graphql.request<{ sessionSettings: ProjectSettings }>(Q_SESSION_SETTINGS, { name })).sessionSettings);

/** Merge `settings` into the session's project settings on the center; `null` removes an item. Returns the whole settings after. */
export const updateSessionSettings = async (name: string, settings: ProjectSettings): Promise<ProjectSettings> =>
  toSettings((await graphql.request<{ updateSessionSettings: ProjectSettings }>(M_UPDATE_SESSION_SETTINGS, { name, settings })).updateSessionSettings);
