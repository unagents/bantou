import { invoke } from "@tauri-apps/api/core";
import type { BrokerStatus, Ping, Thread } from "~/types";

export const THREADS_CHANGED_EVENT = "bantou://threads-changed";
export const PINGS_CHANGED_EVENT = "bantou://pings-changed";
export const AGENT_EVENT = "bantou://agent";

export const listThreads = () => invoke<Thread[]>("list_threads");

export const getThread = (taskId: string) => invoke<Thread | null>("get_thread", { taskId });

export const brokerConnect = () => invoke<BrokerStatus>("broker_connect");

export const brokerStatus = () => invoke<BrokerStatus>("broker_status");

export const listPings = () => invoke<Ping[]>("list_pings");

export const agentOpen = (taskId: string) => invoke<void>("agent_open", { taskId });

export const agentClose = (taskId: string) => invoke<void>("agent_close", { taskId });

export const agentSay = (taskId: string, text: string) =>
  invoke<void>("agent_say", { taskId, text });

export const agentAnswer = (taskId: string, answer: string) =>
  invoke<void>("agent_answer", { taskId, answer });
