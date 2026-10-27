/** Storage conventions (docs/protocol.md "Storage"). Pure string functions; no fs access. */

/** Data root relative to the home directory. */
export const DATA_ROOT_REL = ".local/share/bantou";

/** `<workspace-key>`: the workspace path with `/` replaced by `-`. */
export function workspaceKey(workspacePath: string): string {
  return workspacePath.replaceAll("/", "-");
}

function join(...parts: string[]): string {
  return parts.join("/").replace(/\/{2,}/g, "/");
}

/** `<home>/.local/share/bantou/<workspace-key>` */
export function bantouDir(home: string, workspacePath: string): string {
  return join(home, DATA_ROOT_REL, workspaceKey(workspacePath));
}

/** Registered sessions (roster). */
export function sessionsPath(home: string, workspacePath: string): string {
  return join(bantouDir(home, workspacePath), "sessions.json");
}

/** Waiting thread + timeline + responder session id. */
export function threadPath(home: string, workspacePath: string, taskId: string): string {
  return join(bantouDir(home, workspacePath), "threads", `${taskId}.json`);
}

/** Non-envelope messages. */
export function inboxPath(home: string, workspacePath: string): string {
  return join(bantouDir(home, workspacePath), "inbox.jsonl");
}

/** Cork status list (read only), inside the workspace. */
export function corkConfigPath(workspacePath: string): string {
  return join(workspacePath, ".cork.json");
}
