import { getTransport } from "~/tauri";

export const pickDirectory = () => getTransport().invoke<string | null>("pick_directory");

export const setWorkspaceDirectory = (path: string) =>
  getTransport().invoke<void>("set_workspace_directory", { path });

export const getWorkspaceDirectory = () => getTransport().invoke<string | null>("get_workspace_directory");

export const listWorkspaceHistory = () => getTransport().invoke<string[]>("list_workspace_history");
