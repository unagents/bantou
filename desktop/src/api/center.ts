import { invoke } from "@tauri-apps/api/core";
import type { CenterConnection, CenterConnectSnippets, CenterParsedConnect, CenterSettings, CenterStatus, McpToolResult } from "~/types";

export const centerGetSettings = () => invoke<CenterSettings>("center_get_settings");

export const centerSetSettings = (settings: CenterSettings) =>
  invoke<CenterSettings>("center_set_settings", { settings });

/** Mint a new token, store it and restart a running center with it. Returns the token. */
export const centerRegenerateToken = () => invoke<string>("center_regenerate_token");

/** Addresses of this machine (IPv4 first, then IPv6): the choices for the center's bind. */
export const centerLocalIps = () => invoke<string[]>("center_local_ips");

/** Connection snippets (mcp.json / claude mcp add) for the given bind, port and token. The bind is the host they name. */
export const centerConnectSnippets = (bind: string, port: number, token: string) =>
  invoke<CenterConnectSnippets>("center_connect_snippets", { bind, port, token });

/** Read a pasted connection snippet (either format) into URL and token. Rejects with a readable message. */
export const centerParseConnect = (text: string) => invoke<CenterParsedConnect>("center_parse_connect", { text });

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
