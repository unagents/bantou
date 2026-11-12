import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { watch as watchFs } from "@tauri-apps/plugin-fs";
import { error, info, warn } from "@tauri-apps/plugin-log";
import { relaunch } from "@tauri-apps/plugin-process";
import { check, type Update } from "@tauri-apps/plugin-updater";

import { getTransport, type UnlistenFn } from "./transport";

// Desktop-only capabilities that are not a command / event of the center contract: updater, relaunch, opening a URL,
// file drop, webview log, file watching, the window handle. One interface so another shell can supply its own.

export type { Update };

export type DownloadProgress = Parameters<Update["downloadAndInstall"]>[0] extends
  | ((event: infer E) => void)
  | undefined
  | null
  ? E
  : never;

export interface Platform {
  checkForUpdate(): Promise<Update | null>;
  downloadAndInstall(update: Update, onProgress?: (event: DownloadProgress) => void): Promise<void>;
  relaunch(): Promise<void>;
  /** Open an http(s) URL (already checked by the caller) in the default browser. */
  openExternal(href: string): Promise<void>;
  /** Files dropped on the window: `position` is in physical pixels. */
  onFilesDropped(handler: (paths: string[], position: { x: number; y: number }) => void): Promise<UnlistenFn>;
  /** Write one line to the log file. */
  log(level: "info" | "warn" | "error", message: string): Promise<void>;
  /** Call `onChange` with the changed paths directly under `path` (non-recursive, debounced). */
  watchDir(path: string, onChange: (paths: string[]) => void, delayMs: number): Promise<UnlistenFn>;
  /** The window this code runs in: its label and an event listener scoped to it. */
  currentWindow(): { label: string; listen(event: string, handler: () => void): Promise<UnlistenFn> };
}

const logWrite = { info, warn, error } as const;

const tauriPlatform: Platform = {
  checkForUpdate: () => check(),
  downloadAndInstall: (update, onProgress) => update.downloadAndInstall(onProgress),
  relaunch: () => relaunch(),
  openExternal: (href) => getTransport().invoke<void>("plugin:shell|open", { path: href }),
  onFilesDropped: (handler) =>
    getCurrentWebview().onDragDropEvent((e) => {
      if (e.payload.type === "drop") handler(e.payload.paths, e.payload.position);
    }),
  log: (level, message) => logWrite[level](message),
  watchDir: (path, onChange, delayMs) =>
    watchFs(path, (event) => onChange(event.paths), { recursive: false, delayMs }),
  currentWindow: () => {
    const win = getCurrentWebviewWindow();
    return { label: win.label, listen: (event, handler) => win.listen(event, () => handler()) };
  },
};

export const getPlatform = (): Platform => tauriPlatform;
