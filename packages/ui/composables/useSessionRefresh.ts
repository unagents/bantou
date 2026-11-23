import { getTransport, type UnlistenFn } from "~/tauri";
import { useIntervalFn } from "@vueuse/core";
import { createRefreshGate, KEY_REFRESH_MIN_MS } from "./refreshGate";
import { CENTER_RUNNING_EVENT, errorText, logWebview, onSessionsChanged, OS_NETWORK_EVENT, OS_WAKE_EVENT, refreshSessions } from "../api";

/** Insurance against missed notifications: long on purpose. */
export const SAFETY_REFRESH_MS = 5 * 60_000;
/** Network changes come in bursts (addresses come and go); wait for it to settle. */
export const NETWORK_SETTLE_MS = 2000;
/** After wake the network is often not up yet: ask once more a bit later. */
export const WAKE_RETRY_MS = 5000;
/** Start-up (and sidecar start): the center may not listen yet, so read again at this interval until it answers. */
export const STARTUP_RETRY_MS = 2000;
/** Give up the quick retries after this long; the normal triggers take over. */
export const STARTUP_RETRY_CAP_MS = 60_000;

/**
 * Keeps the side menu in step with the center's `session_list`.
 *
 * The list is read again (`api/sessions.ts` keeps the last list; unreachable is reported with it):
 * - before the user does anything in the window (pointer: capture phase, every time; key: capture phase, at most once per
 *   `KEY_REFRESH_MIN_MS`, so typing in a terminal does not read the list per key; the first key after a pause still does),
 * - when the center reports a session change (subscription `sessionsChanged`; reason created / deleted / restored / updated / context / activity, not filtered),
 * - when the OS reports a wake from sleep (and once more shortly after) or a network change,
 * - when the own sidecar center is started (`bantou://center-running`),
 * - when `refreshNow()` is called by the owner (target changed: settings, pasted connection),
 * - on a long timer.
 * The first read at start-up (and the one at a sidecar start) often runs before the center listens: while it fails the read
 * is repeated every `STARTUP_RETRY_MS` for at most `STARTUP_RETRY_CAP_MS`, and stops at the first success.
 * Requests do not pile up: one in flight, at most one more queued behind it.
 */
export function useSessionRefresh() {
  let inflight: Promise<void> | null = null;
  let queued = false;
  let lastReachable = true;
  let alive = true;

  function refreshNow(): Promise<void> {
    if (inflight) {
      queued = true;
      return inflight;
    }
    inflight = (async () => {
      do {
        queued = false;
        try {
          lastReachable = (await refreshSessions()).reachable;
        } catch (e) {
          logWebview("warn", `session list refresh call failed: ${errorText(e)}`);
          lastReachable = false;
          // The result is carried by the list itself (reachable: false); nothing to show here.
        }
      } while (queued);
    })().finally(() => {
      inflight = null;
    });
    return inflight;
  }

  let quick: ReturnType<typeof setTimeout> | undefined;
  let quickUntil = 0;
  let quickOn = false;

  /** Read now; while the center cannot be asked, keep reading at a short interval (one loop at a time). */
  function refreshUntilReachable(): void {
    quickUntil = Date.now() + STARTUP_RETRY_CAP_MS;
    if (quickOn) return;
    quickOn = true;
    const step = async () => {
      await refreshNow();
      if (!alive || lastReachable || Date.now() >= quickUntil) {
        quickOn = false;
        return;
      }
      quick = setTimeout(() => void step(), STARTUP_RETRY_MS);
    };
    void step();
  }

  const keyGate = createRefreshGate(KEY_REFRESH_MIN_MS);
  const onUserAction = () => void refreshNow();
  const onKey = () => {
    if (keyGate.pass()) void refreshNow();
  };

  let settle: ReturnType<typeof setTimeout> | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  const unlisten: UnlistenFn[] = [];

  const { pause, resume } = useIntervalFn(() => void refreshNow(), SAFETY_REFRESH_MS, { immediate: false });

  onMounted(async () => {
    document.addEventListener("pointerdown", onUserAction, true);
    document.addEventListener("keydown", onKey, true);
    unlisten.push(
      onSessionsChanged(() => void refreshNow()),
      await getTransport().listen(OS_WAKE_EVENT, () => {
        void refreshNow();
        clearTimeout(retry);
        retry = setTimeout(() => void refreshNow(), WAKE_RETRY_MS);
      }),
      await getTransport().listen(CENTER_RUNNING_EVENT, () => refreshUntilReachable()),
      await getTransport().listen(OS_NETWORK_EVENT, () => {
        clearTimeout(settle);
        settle = setTimeout(() => void refreshNow(), NETWORK_SETTLE_MS);
      }),
    );
    resume();
    refreshUntilReachable();
  });

  onBeforeUnmount(() => {
    alive = false;
    clearTimeout(quick);
    document.removeEventListener("pointerdown", onUserAction, true);
    document.removeEventListener("keydown", onKey, true);
    unlisten.forEach((u) => u());
    clearTimeout(settle);
    clearTimeout(retry);
    pause();
  });

  return { refreshNow };
}
