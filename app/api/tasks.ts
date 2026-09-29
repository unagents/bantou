import { invoke } from "@tauri-apps/api/core";
import type { Task } from "~/types";

export const listTasks = () => invoke<Task[]>("list_tasks");

export const getStatuses = () => invoke<string[]>("get_statuses");

export const createTask = (title: string, status: string, tags: string[]) =>
  invoke<Task>("create_task", { title, status, tags });

export const updateTaskStatus = (path: string, status: string) =>
  invoke<Task>("update_task_status", { path, status });
