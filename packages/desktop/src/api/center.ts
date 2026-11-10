import { invoke } from "@tauri-apps/api/core";
import type { CenterRetireResult, CenterConnection, CenterConnectSnippets, CenterIpStatus, CenterLoginCode, CenterLoginStart, CenterParsedConnect, CenterCommonSettings, CenterSettings, CenterStatus, McpToolResult, ProjectSettings } from "~/types";

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

/** The center-wide settings (`center_settings_get`): `{ settings }`, a session's project settings without `servers`. */
export const centerCommonSettingsGet = () => centerTool<{ settings: CenterCommonSettings }>("center_settings_get");

/** Merge `settings` into the center-wide settings (`center_settings_update`; `null` removes an item). Returns the whole settings after. */
export const centerCommonSettingsUpdate = (settings: CenterCommonSettings) =>
  centerTool<{ settings: CenterCommonSettings }>("center_settings_update", { settings });

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

/**
 * Check a URL before it is handed to the OS: trimmed, no control characters, http(s) only, a host, no userinfo.
 * Returns the normalized string (`URL.href`) to open; throws a readable error otherwise.
 * The host is not restricted to claude's login host (no primary source for the full list; a fixed list could block a valid URL).
 */
export function checkExternalUrl(raw: string): string {
  const s = raw.trim();
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(s)) throw new Error("URL に制御文字・改行が入っている");
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    throw new Error("URL として読めない");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("http(s) の URL のみ開ける");
  if (!u.hostname) throw new Error("URL に host が無い");
  if (u.username || u.password) throw new Error("URL にユーザー情報（user:pass@）が入っている");
  return u.href;
}

/**
 * Open an http(s) URL in this Mac's default browser (tauri-plugin-shell `open`, permission `shell:allow-open`).
 * The re-login URL is opened here, on the desktop's machine — never on the center's host.
 * The URL comes from the center (another host), so it is checked here, right before `invoke`.
 */
export const openExternalUrl = (url: string) => {
  let href: string;
  try {
    href = checkExternalUrl(url);
  } catch (e) {
    return Promise.reject(e instanceof Error ? e : new Error(String(e)));
  }
  return invoke<void>("plugin:shell|open", { path: href });
};

/** Retire a server (`server_retire`, irreversible). `serverId` is the server_id (never a host name: two servers can share a host). Rejects with the center's reason (not supported, no reply, ...). */
export const serverRetire = (serverId: string) => centerToolStrict<CenterRetireResult>("server_retire", { server: serverId });

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
