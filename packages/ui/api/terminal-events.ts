// What a `terminalOutput` event does to the screens (pure; no Tauri / Nuxt import, so it is tested on its own).

import type { SessionOutput, SessionOutputStatus } from "./terminal";

export interface TerminalEvent {
  type: "output" | "reset" | "status";
  id: number | null;
  data: string | null;
  status: string | null;
}

/** The resume point (`after`) of one session's stream, and the handler of its events. */
export function createTerminalFeed(
  session: string,
  after: number | null,
  emitOutput: (p: SessionOutput) => void,
  emitStatus: (p: SessionOutputStatus) => void,
) {
  let last = after;
  return {
    /** Read at each (re)connect: a reopened stream continues from the last chunk it delivered. */
    variables: () => ({ session, after: last }),
    onNext({ terminalOutput: ev }: { terminalOutput: TerminalEvent }) {
      if (ev.type === "output" && ev.id !== null && ev.data !== null) {
        last = ev.id;
        emitOutput({ session, id: ev.id, data: ev.data, reset: false });
      } else if (ev.type === "reset") {
        last = null;
        emitOutput({ session, id: 0, data: "", reset: true });
      } else if (ev.type === "status") {
        // `status` (end): shown at once as `retrying` (what the old stream's drop showed), without waiting for the stream
        // to close; the stream is opened again after it (a later `connected` follows)
        emitStatus({ session, state: "retrying", message: null });
      }
    },
  };
}
