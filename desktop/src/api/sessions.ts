import { invoke } from "@tauri-apps/api/core";
import type { Session } from "~/types";

export const SESSIONS_CHANGED_EVENT = "bantou://sessions-changed";
/** The machine woke from sleep (emitted by the Rust side). */
export const OS_WAKE_EVENT = "bantou://os-wake";
/** A network interface or address changed (emitted by the Rust side). */
export const OS_NETWORK_EVENT = "bantou://os-network-changed";

/** Sessions added so far (memory on the Rust side), without asking the center. */
export const listSessions = () => invoke<Session[]>("list_sessions");

/** Ask the center for `session_list` again and reconcile: listed / lost / unreachable. */
export const refreshSessions = () => invoke<Session[]>("refresh_sessions");

/** Add sessions of the center's list by name. */
export const addSessions = (names: string[]) => invoke<Session[]>("add_sessions", { names });

/** Create a session on the center (`session_create`) and add it. */
export const createSession = (name: string) => invoke<Session>("create_session", { name });

export const instructAddTask = (session: string, title: string, body: string) =>
  invoke<void>("instruct_add_task", { session, title, body });

export const unregisterSession = (name: string) => invoke<void>("unregister_session", { name });
