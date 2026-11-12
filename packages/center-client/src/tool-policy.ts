// Tools the web backend may call on the center (design 5.3). The desktop allows every tool (no `allowTool`).

/** Tools the UI uses through `centerTool` / `centerToolStrict`, plus the ones the backend itself calls. */
export const WEB_ALLOWED_TOOLS: readonly string[] = [
  // used by the UI
  "rc_list",
  "rc_start",
  "rc_stop",
  "server_list",
  "server_peers",
  "remote_list",
  "worker_reply",
  "session_login",
  "session_login_code",
  "center_settings_get",
  "center_settings_update",
  // used inside the backend
  "session_list",
  "session_create",
  "session_update",
  "session_settings_get",
  "session_settings_update",
  "center_info",
];
// Not allowed on purpose: `session_delete` (the desktop UI does not use it) and
// `server_retire` (irreversible; desktop only, design 5.3 / decision 10).

const allowed = new Set(WEB_ALLOWED_TOOLS);

/** `policy.allowTool` for the web backend. */
export const allowWebTool = (name: string): boolean => allowed.has(name);
