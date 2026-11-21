import { getTransport, type UnlistenFn } from "~/tauri";
import { CENTER_SESSION_MESSAGE_EVENT } from "../api";

/** One entry of the drawer: a session's last response of a turn. */
export interface DrawerMessage {
  /** Arrival order (0, 1, 2 ...). */
  seq: number;
  session: string;
  text: string;
  /** When the center got it (ISO). */
  at: string;
}

/** Width (px) of the opened panel. */
export const DRAWER_WIDTH = 340;

/**
 * The drawer's messages: every `center-session-message` is appended in the order it arrives (memory only).
 * Listening starts on mount and stops on unmount.
 */
export function useMessageDrawer() {
  const messages = ref<DrawerMessage[]>([]);
  let seq = 0;
  let unlisten: UnlistenFn | null = null;
  let alive = true;

  function push(m: { session?: unknown; text?: unknown; at?: unknown }) {
    if (typeof m.session !== "string" || typeof m.text !== "string") return;
    const at = typeof m.at === "string" ? m.at : new Date().toISOString();
    messages.value = [...messages.value, { seq: seq++, session: m.session, text: m.text, at }];
  }

  onMounted(async () => {
    const un = await getTransport().listen<{ session?: unknown; text?: unknown; at?: unknown }>(CENTER_SESSION_MESSAGE_EVENT, push);
    if (alive) unlisten = un;
    else un();
  });
  onBeforeUnmount(() => {
    alive = false;
    unlisten?.();
  });

  return { messages, push };
}
