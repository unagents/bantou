import { getTransport } from "~/tauri";
import type { Task } from "~/types";

export const listTasks = () => getTransport().invoke<Task[]>("list_tasks");

export const getStatuses = () => getTransport().invoke<string[]>("get_statuses");
