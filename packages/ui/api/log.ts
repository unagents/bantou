import { getPlatform } from "~/tauri";

// Webview side of the investigation log: the lines go to the same file as the Rust ones
// (`bantou.log` in the OS log directory, written by `tauri-plugin-log`). Logging never throws.

/** Write `message` to the log file, prefixed with `[webview]`. A failing log call is dropped. */
export function logWebview(level: "info" | "warn" | "error", message: string): void {
  try {
    getPlatform()
      .log(level, `[webview] ${message}`)
      .catch(() => {});
  } catch {
    // outside Tauri (plain browser) there is no log plugin
  }
}

/** One-line text of a caught value. */
export const errorText = (e: unknown): string => (e instanceof Error ? (e.stack ?? e.message) : String(e));
