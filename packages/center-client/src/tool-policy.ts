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

/** Why a call is refused although the tool itself is allowed (shown to the user). Holds no value of the item. */
export const CENTER_ONLY_REFUSAL =
  "外部記憶（memory）や MCP の接続の設定は web からは変えられない（url・token・agentId などは center の側だけで扱う）。center を動かしている host の command（`bantou-center memory` など）を使う";
export const MEMORY_REFUSAL = CENTER_ONLY_REFUSAL;

/** Setting keys only the center handles (a screen / the web cannot set or delete them; null too). */
export const CENTER_ONLY_KEYS: readonly string[] = ["memory", "mcp", "mcpServers", "mcpConnections", "mcpSecrets", "coordinator"];

/** True when `settings` has a center-only key (null value included). */
export const hasCenterOnlyKey = (settings: object): boolean => CENTER_ONLY_KEYS.some((k) => Object.prototype.hasOwnProperty.call(settings, k));

// Tools whose `settings` argument could carry the memory setting.
const SETTINGS_TOOLS: ReadonlySet<string> = new Set(["session_create", "session_settings_update", "center_settings_update"]);

/**
 * The reason a call is refused by its arguments, or undefined. The memory setting (url / token / agentId) is not
 * changed from a screen: a `settings` with a `memory` key (null too) is refused, not silently dropped. The center
 * refuses it as well; this refuses before anything is sent.
 */
export function webToolArgsRefusal(name: string, args: unknown): string | undefined {
  if (!SETTINGS_TOOLS.has(name)) return undefined;
  if (typeof args !== "object" || args === null) return undefined;
  const settings = (args as { settings?: unknown }).settings;
  if (typeof settings !== "object" || settings === null) return undefined;
  return hasCenterOnlyKey(settings) ? CENTER_ONLY_REFUSAL : undefined;
}
