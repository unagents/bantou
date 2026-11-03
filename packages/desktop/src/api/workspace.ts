import { invoke } from "@tauri-apps/api/core";

export const pickDirectory = () => invoke<string | null>("pick_directory");

export const setWorkspaceDirectory = (path: string) =>
  invoke<void>("set_workspace_directory", { path });

export const getWorkspaceDirectory = () => invoke<string | null>("get_workspace_directory");

export const listWorkspaceHistory = () => invoke<string[]>("list_workspace_history");
