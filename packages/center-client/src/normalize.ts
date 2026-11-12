// Mirror of `packages/desktop/src-tauri/src/center_mcp.rs` normalize_remote / redact_url.

export const MCP_PATH = "/mcp";

/**
 * A connection URL in its one canonical form: repeated slashes in the path collapse to one, a
 * trailing `/` is dropped, and an empty path becomes `/mcp`. Unparsable input is returned as is.
 * (center_mcp.rs `normalize_remote`)
 */
export function normalizeRemote(u: string): string {
  let url: URL;
  try {
    url = new URL(u.trim());
  } catch {
    return u;
  }
  let path = "";
  for (const seg of url.pathname.split("/")) {
    if (seg !== "") path += `/${seg}`;
  }
  if (path === "") path = MCP_PATH;
  url.pathname = path;
  return url.href;
}

/**
 * `url` for an error message shown to the user: no credentials, no query, no fragment.
 * (center_mcp.rs `redact_url`)
 */
export function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    u.username = "";
    u.password = "";
    u.search = "";
    u.hash = "";
    return u.href;
  } catch {
    return url.split(/[?#]/)[0] ?? "";
  }
}
