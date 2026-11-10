import { invoke } from "@tauri-apps/api/core";
import type {
  CenterConnection,
  CenterConnectSnippets,
  CenterIpStatus,
  CenterLoginCode,
  CenterLoginStart,
  CenterParsedConnect,
  CenterSettings,
  CenterStatus,
  McpToolResult,
} from "~/types";

export const centerGetSettings = () => invoke<CenterSettings>("center_get_settings");

export const centerSetSettings = (settings: CenterSettings) =>
  invoke<CenterSettings>("center_set_settings", { settings });

/** Mint a new token, store it and restart a running center with it. Returns the token. */
export const centerRegenerateToken = () => invoke<string>("center_regenerate_token");

/** Addresses of this machine (IPv4 first, then IPv6): the choices for the host of the connection settings. */
export const centerLocalIps = () => invoke<string[]>("center_local_ips");

/** The saved IP checked against this machine's addresses now (missing = the saved IP is gone). */
export const centerIpStatus = () => invoke<CenterIpStatus>("center_ip_status");

/** Connection snippets (mcp.json / claude mcp add) for the given IP, port and token. The IP is the host they name. */
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

/** Call a center tool; a result flagged `isError` (`{ error }` or a failed result) rejects with its text. */
export async function centerToolStrict<T>(name: string, args?: Record<string, unknown>): Promise<T> {
  const r = await centerCall(name, args);
  const text = r.content.map((c) => c.text ?? "").join("");
  if (r.isError) {
    let message = text;
    try {
      const v = JSON.parse(text) as { error?: string };
      if (typeof v.error === "string") message = v.error;
    } catch {
      // not JSON: keep the text
    }
    throw new Error(message || `${name} failed`);
  }
  return JSON.parse(text) as T;
}

/** Start `/login` in the session's claude (`session_login`): resolves with the URL to open in a browser. */
export const sessionLogin = (name: string) => centerToolStrict<CenterLoginStart>("session_login", { name });

/**
 * Feed the code from the browser to the session's claude (`session_login_code`). Resolves with the result also when
 * the login failed (`ok: false`, `error` says why); rejects only when the call itself failed (timeout, no pty).
 */
export async function sessionLoginCode(name: string, code: string): Promise<CenterLoginCode> {
  const r = await centerCall("session_login_code", { name, code });
  const text = r.content.map((c) => c.text ?? "").join("");
  // A failed login still has `ok: false`; a failed call (timeout, no pty) has only `error`.
  const v = JSON.parse(text) as Partial<CenterLoginCode> & { error?: string | null };
  if (typeof v.ok !== "boolean") throw new Error(v.error ?? `session_login_code: ${text}`);
  return v as CenterLoginCode;
}

/** Stop the session's claude and start it again with `--continue` (`rc_stop` + `rc_start resume`). */
export async function sessionRestart(name: string): Promise<void> {
  await centerToolStrict("rc_stop", { project: name });
  await centerToolStrict("rc_start", { project: name, resume: true });
}
