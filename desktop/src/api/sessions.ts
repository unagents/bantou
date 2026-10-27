import { invoke } from "@tauri-apps/api/core";
import type { Peer, RegisterResult, Session } from "~/types";

export const SESSIONS_CHANGED_EVENT = "bantou://sessions-changed";

export const listSessions = () => invoke<Session[]>("list_sessions");

export const listPeers = () => invoke<Peer[]>("list_peers");

export const registerSessions = (peers: Peer[]) =>
  invoke<RegisterResult[]>("register_sessions", { peers });

export const instructAddTask = (session: string, title: string, body: string) =>
  invoke<void>("instruct_add_task", { session, title, body });

export const unregisterSession = (name: string) => invoke<void>("unregister_session", { name });
