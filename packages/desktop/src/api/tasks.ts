import { invoke } from "@tauri-apps/api/core";
import type { Task } from "~/types";

export const listTasks = () => invoke<Task[]>("list_tasks");

export const getStatuses = () => invoke<string[]>("get_statuses");
