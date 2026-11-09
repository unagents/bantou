import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import {
  CHECK_FOR_UPDATES_EVENT,
  checkForUpdate,
  downloadAndInstall,
  errorText,
  logWebview,
  relaunchApp,
  type DownloadProgress,
} from "~/api";
import type { UpdaterState } from "~/types";

const MAIN_WINDOW_LABEL = "main";
// How long "最新" stays in the header before it returns to the idle label.
const LATEST_SHOWN_MS = 2000;

// Failed auto checks retry after these delays (the last one repeats, i.e. the cap is 30 min).
const RETRY_BACKOFF_MS = [60_000, 5 * 60_000, 30 * 60_000];
// While idle and up to date, re-check this often.
const RECHECK_INTERVAL_MS = 6 * 60 * 60_000;

// The launch auto-check fires once per process: only the `main` window runs it
// (workspace-* windows skip it), and this flag keeps HMR / remounts from
// firing it twice.
const autoCheckFiredOnce = { current: false };

// One auto-check timer per process, owned by the `main` window's composable.
// `owner` is that composable's token; a second instance never arms a timer.
// `failures` and `settled` outlive the owner so a remount (HMR) continues the backoff:
// `failures` = consecutive failed auto checks, `settled` = the owner has seen a check finish.
// Only the owner updates them (a stale instance finishing late must not).
const autoSchedule: {
  owner: symbol | null;
  timer: ReturnType<typeof setTimeout> | null;
  failures: number;
  settled: boolean;
} = { owner: null, timer: null, failures: 0, settled: false };

function backoffDelay(failures: number) {
  return RETRY_BACKOFF_MS[Math.min(Math.max(failures, 1), RETRY_BACKOFF_MS.length) - 1]!;
}

export function useUpdater() {
  const state = shallowRef<UpdaterState>({ kind: "idle" });
  // A stale resolve from an earlier check must not overwrite a fresher one.
  let requestId = 0;
  let latestTimer: ReturnType<typeof setTimeout> | null = null;
  const token = Symbol("useUpdater");

  function clearAutoTimer() {
    if (autoSchedule.owner !== token) return;
    if (autoSchedule.timer) clearTimeout(autoSchedule.timer);
    autoSchedule.timer = null;
  }

  // Arms the single auto-check timer. The callback only checks while idle:
  // available / checking / downloading / installing / error are left alone and
  // the transition out of them (manual up-to-date) arms it again.
  function armAutoTimer(delayMs: number) {
    if (autoSchedule.owner !== token) return;
    clearAutoTimer();
    autoSchedule.timer = setTimeout(() => {
      autoSchedule.timer = null;
      if (state.value.kind === "idle") void runCheck("auto");
    }, delayMs);
  }

  async function runCheck(mode: "auto" | "manual") {
    const k = state.value.kind;
    if (k === "checking" || k === "downloading" || k === "installing") return;

    if (latestTimer) clearTimeout(latestTimer);
    // A manual check supersedes any pending auto timer; it re-arms below if still up to date.
    clearAutoTimer();
    const id = ++requestId;
    state.value = { kind: "checking" };
    try {
      const update = await checkForUpdate();
      logWebview("info", `update check (${mode}): ${update ? `v${update.version} available` : "up to date"}`);
      if (id !== requestId) return;
      if (autoSchedule.owner === token) autoSchedule.settled = true;
      if (update) {
        state.value = { kind: "available", update, version: update.version };
      } else {
        if (autoSchedule.owner === token) autoSchedule.failures = 0;
        armAutoTimer(RECHECK_INTERVAL_MS);
        // Manual checks need an explicit "no update" answer (shown briefly); auto stays silent.
        if (mode === "manual") {
          state.value = { kind: "latest" };
          latestTimer = setTimeout(() => {
            if (state.value.kind === "latest") state.value = { kind: "idle" };
          }, LATEST_SHOWN_MS);
        } else {
          state.value = { kind: "idle" };
        }
      }
    } catch (e) {
      logWebview("error", `update check failed (${mode}): ${errorText(e)}`);
      if (id !== requestId) return;
      if (autoSchedule.owner === token) autoSchedule.settled = true;
      if (mode === "manual") {
        state.value = { kind: "error", message: String(e), version: null };
      } else {
        console.error("Auto update check failed:", e);
        state.value = { kind: "idle" };
        if (autoSchedule.owner === token) {
          autoSchedule.failures++;
          armAutoTimer(backoffDelay(autoSchedule.failures));
        }
      }
    }
  }

  async function installAndRestart() {
    const cur = state.value;
    if (cur.kind !== "available") return;
    const { update, version } = cur;
    state.value = { kind: "downloading", version, downloaded: 0, contentLength: null };
    try {
      await downloadAndInstall(update, (ev: DownloadProgress) => {
        if (ev.event === "Started") {
          state.value = {
            kind: "downloading",
            version,
            downloaded: 0,
            contentLength: ev.data.contentLength ?? null,
          };
        } else if (ev.event === "Progress") {
          const s = state.value;
          if (s.kind === "downloading") {
            state.value = { ...s, downloaded: s.downloaded + ev.data.chunkLength };
          }
        } else if (ev.event === "Finished") {
          state.value = { kind: "installing", version };
        }
      });
      await relaunchApp();
    } catch (e) {
      logWebview("error", `update install failed (v${version}): ${errorText(e)}`);
      state.value = { kind: "error", message: String(e), version };
    }
  }

  let unlisten: (() => void) | null = null;
  let unmounted = false;
  onMounted(async () => {
    const win = getCurrentWebviewWindow();
    if (win.label === MAIN_WINDOW_LABEL && autoSchedule.owner === null) {
      autoSchedule.owner = token;
      if (!autoCheckFiredOnce.current) {
        autoCheckFiredOnce.current = true;
        void runCheck("auto");
      } else if (!autoSchedule.settled) {
        // Remount while the previous owner's check was unfinished: run it again now.
        void runCheck("auto");
      } else if (autoSchedule.failures > 0) {
        // Remount during a backoff: continue it.
        armAutoTimer(backoffDelay(autoSchedule.failures));
      } else {
        // Remount after a good check: no second launch check, just resume the periodic one.
        armAutoTimer(RECHECK_INTERVAL_MS);
      }
    }
    // Menu "アップデートを確認..." (emitted to the focused window only).
    const off = await win.listen(CHECK_FOR_UPDATES_EVENT, () => void runCheck("manual"));
    if (unmounted) off();
    else unlisten = off;
  });
  onBeforeUnmount(() => {
    unmounted = true;
    unlisten?.();
    clearAutoTimer();
    if (autoSchedule.owner === token) autoSchedule.owner = null;
    if (latestTimer) clearTimeout(latestTimer);
  });

  return { state, checkManually: () => runCheck("manual"), installAndRestart };
}
