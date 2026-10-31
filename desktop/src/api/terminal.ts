import { invoke } from "@tauri-apps/api/core";

/** One output chunk (or a reset) of a session's terminal, emitted by the Rust SSE client. */
export const SESSION_OUTPUT_EVENT = "session-output";
/** Connection state of the output stream of a session. */
export const SESSION_OUTPUT_STATUS_EVENT = "session-output-status";

/** Mirror of `src-tauri/src/terminal.rs::OutputPayload`. */
export interface SessionOutput {
  session: string;
  /** Chunk id (0 on a reset). */
  id: number;
  /** Base64 of the raw pty bytes (empty on a reset). */
  data: string;
  reset: boolean;
}

/** Mirror of `src-tauri/src/terminal.rs::StatusPayload`. */
export interface SessionOutputStatus {
  session: string;
  state: "connected" | "retrying" | "rejected";
  message: string | null;
}

/** Open the output stream of a session; `after` = the last chunk id already held (null: from the start). */
export const sessionOutputStart = (session: string, after: number | null) =>
  invoke<void>("session_output_start", { session, after });

export const sessionOutputStop = (session: string) => invoke<void>("session_output_stop", { session });

/** Keystrokes (base64 of the bytes) to the session's pty. */
export const sessionInput = (session: string, dataB64: string) =>
  invoke<void>("session_input", { session, dataB64 });

export const sessionResize = (session: string, cols: number, rows: number) =>
  invoke<void>("session_resize", { session, cols, rows });
