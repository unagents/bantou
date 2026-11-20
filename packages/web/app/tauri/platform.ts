import type { UnlistenFn } from "./transport";

// Browser side of the platform seam (desktop: packages/desktop/src/tauri/platform.ts). Capabilities that belong to the
// desktop shell (updater, file drop, file watching) are absent here, not emulated.

/** The shape the shared code reads from a desktop update; the web never finds one. */
export interface Update {
  version: string;
  downloadAndInstall(onProgress?: (event: DownloadProgress) => void): Promise<void>;
}

export type DownloadProgress =
  | { event: "Started"; data: { contentLength?: number } }
  | { event: "Progress"; data: { chunkLength: number } }
  | { event: "Finished" };

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

const none: UnlistenFn = () => {};

const browserPlatform: Platform = {
  // The web app is updated by the server, not by itself.
  checkForUpdate: async () => null,
  downloadAndInstall: async () => {},
  relaunch: async () => location.reload(),
  openExternal: async (href) => {
    window.open(href, "_blank", "noopener,noreferrer");
  },
  // A dropped file has no path in a browser (attachments come from a file input, later).
  onFilesDropped: async () => none,
  log: async (level, message) => console[level](message),
  // There is no folder to watch.
  watchDir: async () => none,
  currentWindow: () => ({ label: "web", listen: async () => none }),
};

export const getPlatform = (): Platform => browserPlatform;
