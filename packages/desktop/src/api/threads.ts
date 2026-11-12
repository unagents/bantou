import { getTransport } from "~/tauri";
import type { BrokerStatus, Ping, Thread } from "~/types";

export const THREADS_CHANGED_EVENT = "bantou://threads-changed";
export const PINGS_CHANGED_EVENT = "bantou://pings-changed";
export const AGENT_EVENT = "bantou://agent";

export const listThreads = () => getTransport().invoke<Thread[]>("list_threads");

export const getThread = (taskId: string) => getTransport().invoke<Thread | null>("get_thread", { taskId });

export const brokerConnect = () => getTransport().invoke<BrokerStatus>("broker_connect");

export const brokerStatus = () => getTransport().invoke<BrokerStatus>("broker_status");

export const listPings = () => getTransport().invoke<Ping[]>("list_pings");

export const agentOpen = (taskId: string) => getTransport().invoke<void>("agent_open", { taskId });

export const agentClose = (taskId: string) => getTransport().invoke<void>("agent_close", { taskId });

export const agentSay = (taskId: string, text: string) =>
  getTransport().invoke<void>("agent_say", { taskId, text });

export const agentAnswer = (taskId: string, answer: string) =>
  getTransport().invoke<void>("agent_answer", { taskId, answer });
