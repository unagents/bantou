import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useIntervalFn } from "@vueuse/core";
import { OS_NETWORK_EVENT, OS_WAKE_EVENT, refreshSessions } from "~/api";

/** Insurance against missed notifications: long on purpose. */
export const SAFETY_REFRESH_MS = 5 * 60_000;
/** Network changes come in bursts (addresses come and go); wait for it to settle. */
export const NETWORK_SETTLE_MS = 2000;
/** After wake the network is often not up yet: ask once more a bit later. */
export const WAKE_RETRY_MS = 5000;

/**
 * Keeps the side menu in step with the center's `session_list`.
 *
 * The list is read again (Rust keeps the last list; unreachable is reported with it):
 * - before the user does anything in the window (pointer or key, capture phase, every time),
 * - when the OS reports a wake from sleep (and once more shortly after) or a network change,
 * - when `refreshNow()` is called by the owner (target changed: settings, pasted connection),
 * - on a long timer.
 * Requests do not pile up: one in flight, at most one more queued behind it.
 */
export function useSessionRefresh() {
  let inflight: Promise<void> | null = null;
  let queued = false;

  function refreshNow(): Promise<void> {
    if (inflight) {
      queued = true;
      return inflight;
    }
    inflight = (async () => {
      do {
        queued = false;
        try {
          await refreshSessions();
        } catch {
          // The result is carried by the list itself (reachable: false); nothing to show here.
        }
      } while (queued);
    })().finally(() => {
      inflight = null;
    });
    return inflight;
  }

  const onUserAction = () => void refreshNow();

  let settle: ReturnType<typeof setTimeout> | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  const unlisten: UnlistenFn[] = [];

  const { pause, resume } = useIntervalFn(() => void refreshNow(), SAFETY_REFRESH_MS, { immediate: false });

  onMounted(async () => {
    document.addEventListener("pointerdown", onUserAction, true);
    document.addEventListener("keydown", onUserAction, true);
    unlisten.push(
      await listen(OS_WAKE_EVENT, () => {
        void refreshNow();
        clearTimeout(retry);
        retry = setTimeout(() => void refreshNow(), WAKE_RETRY_MS);
      }),
      await listen(OS_NETWORK_EVENT, () => {
        clearTimeout(settle);
        settle = setTimeout(() => void refreshNow(), NETWORK_SETTLE_MS);
      }),
    );
    resume();
    void refreshNow();
  });

  onBeforeUnmount(() => {
    document.removeEventListener("pointerdown", onUserAction, true);
    document.removeEventListener("keydown", onUserAction, true);
    unlisten.forEach((u) => u());
    clearTimeout(settle);
    clearTimeout(retry);
    pause();
  });

  return { refreshNow };
}
