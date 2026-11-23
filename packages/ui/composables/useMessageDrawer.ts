import { onSessionMessage } from "../api";

/** One entry of the drawer: a session's final message to the user (its last response of a turn). */
export interface DrawerMessage {
  /** Arrival order (0, 1, 2 ...). */
  seq: number;
  session: string;
  text: string;
  /** When the center got it (ISO). */
  at: string;
}

/** How many messages are kept. The app runs for days: past this the oldest ones are dropped so memory and the list stay bounded. */
export const MAX_DRAWER_MESSAGES = 500;

/**
 * The drawer's messages: every `sessionMessage` of the center is appended in the order it arrives (memory only, the newest
 * `MAX_DRAWER_MESSAGES`). Listening starts on mount and stops on unmount.
 */
export function useMessageDrawer() {
  const messages = ref<DrawerMessage[]>([]);
  let seq = 0;
  let unlisten: (() => void) | null = null;

  function push(m: { session?: unknown; text?: unknown; at?: unknown }) {
    if (typeof m.session !== "string" || typeof m.text !== "string") return;
    const at = typeof m.at === "string" ? m.at : new Date().toISOString();
    const next = [...messages.value, { seq: seq++, session: m.session, text: m.text, at }];
    messages.value = next.length > MAX_DRAWER_MESSAGES ? next.slice(next.length - MAX_DRAWER_MESSAGES) : next;
  }

  onMounted(() => {
    unlisten = onSessionMessage(push);
  });
  onBeforeUnmount(() => {
    unlisten?.();
  });

  return { messages, push };
}
