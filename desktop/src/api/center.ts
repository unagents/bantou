import { invoke } from "@tauri-apps/api/core";
import type { CenterConnection, CenterSettings, CenterStatus, McpToolResult } from "~/types";

export const centerGetSettings = () => invoke<CenterSettings>("center_get_settings");

export const centerSetSettings = (settings: CenterSettings) =>
  invoke<CenterSettings>("center_set_settings", { settings });

export const centerStatus = () => invoke<CenterStatus>("center_status");

export const centerConnection = () => invoke<CenterConnection>("center_connection");

export const centerCall = (name: string, args?: Record<string, unknown>) =>
  invoke<McpToolResult>("center_call", { name, arguments: args });

/** Call a center tool and parse its JSON text result. */
export async function centerTool<T>(name: string, args?: Record<string, unknown>): Promise<T> {
  const r = await centerCall(name, args);
  const text = r.content.map((c) => c.text ?? "").join("");
  return JSON.parse(text) as T;
}
