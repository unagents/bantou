import { getPlatform, getTransport } from "~/tauri";
import { inputText, sniffImageType, toBase64 } from "./attachment-util";
import { graphql } from "./graphql";
import { M_ATTACH_TO_SESSION } from "./graphql-docs";
import { sessionInput } from "./terminal";

/** Mirror of `src-tauri/src/attachment.rs::AttachOutcome`. */
export interface AttachOutcome {
  /** Paths (on the center host) already typed into the session's pty. */
  saved: string[];
  /** One short reason per refused / failed image. */
  errors: string[];
}

/**
 * Clipboard image: saved on the center (`attachToSession`), then its path is typed into the session's pty (`terminalInput`).
 * A refusal comes back in `errors` (one short reason), like the paths of dropped files.
 */
export async function sessionAttachBytes(session: string, bytes: Uint8Array): Promise<AttachOutcome> {
  const type = sniffImageType(bytes);
  if (!type) return { saved: [], errors: ["画像の型が違う（png / jpeg / gif / webp のみ）"] };
  let path: string;
  try {
    path = (await graphql.request<{ attachToSession: { path: string } }>(M_ATTACH_TO_SESSION, { session, type, dataB64: toBase64(bytes) })).attachToSession.path;
  } catch (e) {
    return { saved: [], errors: [e instanceof Error ? e.message : String(e)] };
  }
  const out: AttachOutcome = { saved: [path], errors: [] };
  try {
    await sessionInput(session, toBase64(new TextEncoder().encode(inputText(out.saved))));
  } catch (e) {
    out.errors.push(`path は保存したが入力に書けなかった: ${e instanceof Error ? e.message : String(e)}`);
  }
  return out;
}

/** Dropped files (absolute paths from the drag-drop event). */
export const sessionAttachPaths = (session: string, paths: string[]) =>
  getTransport().invoke<AttachOutcome>("session_attach_paths", { session, paths });

/** File dialog (several files). Cancel returns empty lists. */
export const sessionAttachPick = (session: string) => getTransport().invoke<AttachOutcome>("session_attach_pick", { session });

/** Files dropped on the window: `position` is in physical pixels. */
export const onFilesDropped = (handler: (paths: string[], position: { x: number; y: number }) => void) =>
  getPlatform().onFilesDropped(handler);
