import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  SESSION_OUTPUT_EVENT,
  SESSION_OUTPUT_STATUS_EVENT,
  sessionOutputStart,
  sessionOutputStop,
  type SessionOutput,
  type SessionOutputStatus,
} from "~/api";
import { decodeBase64, SessionBuffer } from "./terminalBuffer";


/** What a terminal view receives: a reset (clear and repaint from what follows) or bytes to write. */
export type TerminalSink = (event: { reset: true } | { bytes: Uint8Array }) => void;


const buffers = new Map<string, SessionBuffer>();
const sinks = new Map<string, TerminalSink>();
/** Latest connection state per session (reactive for the view). */
const status = reactive<Record<string, SessionOutputStatus["state"]>>({});
let unlisten: UnlistenFn[] | null = null;
let listening: Promise<void> | null = null;

function buffer(session: string): SessionBuffer {
  let b = buffers.get(session);
  if (!b) buffers.set(session, (b = new SessionBuffer()));
  return b;
}

function onOutput(p: SessionOutput) {
  const b = buffer(p.session);
  if (p.reset) {
    b.clear();
    sinks.get(p.session)?.({ reset: true });
    return;
  }
  const bytes = decodeBase64(p.data);
  if (b.push(p.id, bytes)) sinks.get(p.session)?.({ bytes });
}

function ensureListening(): Promise<void> {
  listening ??= (async () => {
    unlisten = [
      await listen<SessionOutput>(SESSION_OUTPUT_EVENT, (e) => onOutput(e.payload)),
      await listen<SessionOutputStatus>(SESSION_OUTPUT_STATUS_EVENT, (e) => {
        status[e.payload.session] = e.payload.state;
      }),
    ];
  })();
  return listening;
}

/**
 * Terminal output of center sessions: the Rust side streams it as `session-output` events; this keeps a
 * 2 MiB buffer and the last chunk id per session. The view attaches a sink to get live bytes.
 */
export function useTerminalStore() {
  /** Start streaming `session` (resuming after the chunk id already held) and route its bytes to `sink`. */
  async function attach(session: string, sink: TerminalSink) {
    await ensureListening();
    sinks.set(session, sink);
    const b = buffer(session);
    for (const bytes of b.chunks) sink({ bytes });
    await sessionOutputStart(session, b.lastId);
  }

  async function detach(session: string) {
    sinks.delete(session);
    delete status[session];
    await sessionOutputStop(session);
  }

  return { attach, detach, status };
}

/** Test/teardown hook. */
export function disposeTerminalStore() {
  unlisten?.forEach((u) => u());
  unlisten = null;
  listening = null;
}
