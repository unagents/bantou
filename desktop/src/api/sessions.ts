import { invoke } from "@tauri-apps/api/core";
import type { Session, SessionList } from "~/types";

export const SESSIONS_CHANGED_EVENT = "bantou://sessions-changed";
/** The machine woke from sleep (emitted by the Rust side). */
export const OS_WAKE_EVENT = "bantou://os-wake";
/** A network interface or address changed (emitted by the Rust side). */
export const OS_NETWORK_EVENT = "bantou://os-network-changed";

/** The center's list as last fetched (memory on the Rust side), without asking the center. */
export const listSessions = () => invoke<SessionList>("list_sessions");

/** The center's `GET /events` reported a session created / deleted / restored (forwarded by the Rust side). */
export const CENTER_SESSIONS_CHANGED_EVENT = "center-sessions-changed";

/** Ask the center for `session_list` again. When it cannot be asked, the last list comes back with `reachable: false`. */
export const refreshSessions = () => invoke<SessionList>("refresh_sessions");

/** Create a session on the center (`session_create`). It shows up in the list the center returns. */
export const createSession = (name: string) => invoke<Session>("create_session", { name });

