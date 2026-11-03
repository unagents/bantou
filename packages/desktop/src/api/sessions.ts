import { invoke } from "@tauri-apps/api/core";
import type { ProjectSettings, Session, SessionList, SessionPathHints } from "~/types";

export const SESSIONS_CHANGED_EVENT = "bantou://sessions-changed";
/** The machine woke from sleep (emitted by the Rust side). */
export const OS_WAKE_EVENT = "bantou://os-wake";
/** The own sidecar center was started (it may not be listening yet; emitted by the Rust side). */
export const CENTER_RUNNING_EVENT = "bantou://center-running";
/** A network interface or address changed (emitted by the Rust side). */
export const OS_NETWORK_EVENT = "bantou://os-network-changed";

/** The center's list as last fetched (memory on the Rust side), without asking the center. */
export const listSessions = () => invoke<SessionList>("list_sessions");

/** The center's `GET /events` reported a session created / deleted / restored (forwarded by the Rust side). */
export const CENTER_SESSIONS_CHANGED_EVENT = "center-sessions-changed";

/** Ask the center for `session_list` again. When it cannot be asked, the last list comes back with `reachable: false`. */
export const refreshSessions = () => invoke<SessionList>("refresh_sessions");

/**
 * Create a session on the center (`session_create`). `settings` is the project settings to start with;
 * `path` is the folder on the center's host (blank / omitted: not sent, the center uses `<workspace>/<name>`).
 */
export const createSession = (name: string, settings?: ProjectSettings, path?: string) =>
  invoke<Session>("create_session", { name, path: path?.trim() || null, settings: settings ?? null });

/** For the add dialog's folder field: the center's default parent folder and whether this PC's folder dialog applies. */
export const sessionPathHints = () => invoke<SessionPathHints>("session_path_hints");

/** The project settings of a session, kept by the center (`session_settings_get`). `{}` when none. */
export const getSessionSettings = (name: string) => invoke<ProjectSettings>("session_get_settings", { name });

/** Merge `settings` into the session's project settings on the center; `null` removes an item. Returns the whole settings after. */
export const updateSessionSettings = (name: string, settings: ProjectSettings) =>
  invoke<ProjectSettings>("session_update_settings", { name, settings });
