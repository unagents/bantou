import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";

/** Mirror of `src-tauri/src/attachment.rs::AttachOutcome`. */
export interface AttachOutcome {
  /** Paths (on the center host) already typed into the session's pty. */
  saved: string[];
  /** One short reason per refused / failed image. */
  errors: string[];
}

/** Clipboard image: raw bytes as the request body (no JSON array). */
export const sessionAttachBytes = (session: string, bytes: Uint8Array) =>
  invoke<AttachOutcome>("session_attach_bytes", bytes, {
    headers: { "x-bantou-session": session },
  });

/** Dropped files (absolute paths from the drag-drop event). */
export const sessionAttachPaths = (session: string, paths: string[]) =>
  invoke<AttachOutcome>("session_attach_paths", { session, paths });

/** File dialog (several files). Cancel returns empty lists. */
export const sessionAttachPick = (session: string) => invoke<AttachOutcome>("session_attach_pick", { session });

/** Files dropped on the window: `position` is in physical pixels. */
export const onFilesDropped = (handler: (paths: string[], position: { x: number; y: number }) => void) =>
  getCurrentWebview().onDragDropEvent((e) => {
    if (e.payload.type === "drop") handler(e.payload.paths, e.payload.position);
  });
