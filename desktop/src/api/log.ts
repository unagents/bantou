import { error, info, warn } from "@tauri-apps/plugin-log";

// Webview side of the investigation log: the lines go to the same file as the Rust ones
// (`bantou.log` in the OS log directory, written by `tauri-plugin-log`). Logging never throws.

const write = { info, warn, error } as const;

/** Write `message` to the log file, prefixed with `[webview]`. A failing log call is dropped. */
export function logWebview(level: keyof typeof write, message: string): void {
  try {
    write[level](`[webview] ${message}`).catch(() => {});
  } catch {
    // outside Tauri (plain browser) there is no log plugin
  }
}

/** One-line text of a caught value. */
export const errorText = (e: unknown): string => (e instanceof Error ? (e.stack ?? e.message) : String(e));
