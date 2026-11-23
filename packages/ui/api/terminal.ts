import { graphql } from "./graphql";
import { M_TERMINAL_INPUT, M_TERMINAL_RESIZE, S_TERMINAL_OUTPUT } from "./graphql-docs";
import { createTerminalFeed, type TerminalEvent } from "./terminal-events";

/** One output chunk (or a reset) of a session's terminal (subscription `terminalOutput`). */
export interface SessionOutput {
  session: string;
  /** Chunk id (0 on a reset). */
  id: number;
  /** Base64 of the raw pty bytes (empty on a reset). */
  data: string;
  reset: boolean;
}

/** Connection state of the output stream of a session. */
export interface SessionOutputStatus {
  session: string;
  state: "connected" | "retrying" | "rejected";
  message: string | null;
}

const outputHandlers = new Set<(p: SessionOutput) => void>();
const statusHandlers = new Set<(p: SessionOutputStatus) => void>();

/** Chunks and resets of every open output stream. Returns the function that stops listening. */
export function onSessionOutput(handler: (p: SessionOutput) => void): () => void {
  outputHandlers.add(handler);
  return () => outputHandlers.delete(handler);
}

/** Connection states of every open output stream. Returns the function that stops listening. */
export function onSessionOutputStatus(handler: (p: SessionOutputStatus) => void): () => void {
  statusHandlers.add(handler);
  return () => statusHandlers.delete(handler);
}

const emitOutput = (p: SessionOutput) => outputHandlers.forEach((h) => h(p));
const emitStatus = (p: SessionOutputStatus) => statusHandlers.forEach((h) => h(p));

const streams = new Map<string, () => void>();

/** Open the output stream of a session; `after` = the last chunk id already held (null: from the start). A reopened one (a drop) continues from the last chunk it delivered. */
export async function sessionOutputStart(session: string, after: number | null): Promise<void> {
  streams.get(session)?.();
  const feed = createTerminalFeed(session, after, emitOutput, emitStatus);
  const stop = graphql.subscribe<{ terminalOutput: TerminalEvent }>(S_TERMINAL_OUTPUT, feed.variables, {
    onNext: feed.onNext,
    onOpen: () => emitStatus({ session, state: "connected", message: null }),
    onStatus: (state, message) => emitStatus({ session, state, message }),
  });
  streams.set(session, stop);
}

export async function sessionOutputStop(session: string): Promise<void> {
  streams.get(session)?.();
  streams.delete(session);
}

/** Keystrokes (base64 of the bytes) to the session's pty (`terminalInput`). */
export const sessionInput = async (session: string, dataB64: string): Promise<void> => {
  await graphql.request(M_TERMINAL_INPUT, { session, dataB64 });
};

export const sessionResize = async (session: string, cols: number, rows: number): Promise<void> => {
  await graphql.request(M_TERMINAL_RESIZE, { session, cols, rows });
};
