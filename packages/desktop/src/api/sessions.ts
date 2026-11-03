import { invoke } from "@tauri-apps/api/core";
import type { Session, SessionList } from "~/types";

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

/** Create a session on the center (`session_create`). It shows up in the list the center returns. */
export const createSession = (name: string, instructions?: string) =>
  invoke<Session>("create_session", { name, instructions: instructions?.trim() ? instructions : null });

/** The instructions saved on this desktop for a session (empty when none). */
export const getSessionInstructions = (name: string) => invoke<string>("session_get_instructions", { name });

/** Save the instructions of a session in `settings.json` (blank removes them). */
export const setSessionInstructions = (name: string, instructions: string) =>
  invoke<void>("session_set_instructions", { name, instructions });

