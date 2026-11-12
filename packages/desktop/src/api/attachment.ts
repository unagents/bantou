import { getPlatform, getTransport } from "~/tauri";

/** Mirror of `src-tauri/src/attachment.rs::AttachOutcome`. */
export interface AttachOutcome {
  /** Paths (on the center host) already typed into the session's pty. */
  saved: string[];
  /** One short reason per refused / failed image. */
  errors: string[];
}

/** Clipboard image: raw bytes as the request body (no JSON array). */
export const sessionAttachBytes = (session: string, bytes: Uint8Array) =>
  getTransport().invoke<AttachOutcome>("session_attach_bytes", undefined, {
    headers: { "x-bantou-session": session },
    body: bytes,
  });

/** Dropped files (absolute paths from the drag-drop event). */
export const sessionAttachPaths = (session: string, paths: string[]) =>
  getTransport().invoke<AttachOutcome>("session_attach_paths", { session, paths });

/** File dialog (several files). Cancel returns empty lists. */
export const sessionAttachPick = (session: string) => getTransport().invoke<AttachOutcome>("session_attach_pick", { session });

/** Files dropped on the window: `position` is in physical pixels. */
export const onFilesDropped = (handler: (paths: string[], position: { x: number; y: number }) => void) =>
  getPlatform().onFilesDropped(handler);
