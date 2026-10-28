import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import {
  CHECK_FOR_UPDATES_EVENT,
  checkForUpdate,
  downloadAndInstall,
  relaunchApp,
  type DownloadProgress,
} from "~/api";
import type { UpdaterState } from "~/types";

const MAIN_WINDOW_LABEL = "main";

// The auto-check fires once per process: only the `main` window runs it
// (workspace-* windows skip it), and this flag keeps HMR / remounts from
// firing it twice.
const autoCheckFiredOnce = { current: false };

export function useUpdater() {
  const toast = useToast();
  const state = shallowRef<UpdaterState>({ kind: "idle" });
  // A stale resolve from an earlier check must not overwrite a fresher one.
  let requestId = 0;

  async function runCheck(mode: "auto" | "manual") {
    const k = state.value.kind;
    if (k === "checking" || k === "downloading" || k === "installing") return;

    const id = ++requestId;
    state.value = { kind: "checking" };
    try {
      const update = await checkForUpdate();
      if (id !== requestId) return;
      if (update) {
        state.value = { kind: "available", update, version: update.version };
      } else {
        // Manual checks need an explicit "no update" answer; auto stays silent.
        if (mode === "manual") toast.add({ title: "bantou は最新です", color: "neutral" });
        state.value = { kind: "idle" };
      }
    } catch (e) {
      if (id !== requestId) return;
      if (mode === "manual") {
        toast.add({ title: "アップデートの確認に失敗", description: String(e), color: "error" });
      } else {
        console.error("Auto update check failed:", e);
      }
      state.value = { kind: "idle" };
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
      state.value = { kind: "error", message: String(e), version };
    }
  }

  function dismiss() {
    // Ignore a stale close of an earlier toast (e.g. the one whose action started the install).
    const k = state.value.kind;
    if (k !== "available" && k !== "error") return;
    state.value = { kind: "idle" };
  }

  let unlisten: (() => void) | null = null;
  onMounted(async () => {
    const win = getCurrentWebviewWindow();
    if (!autoCheckFiredOnce.current && win.label === MAIN_WINDOW_LABEL) {
      autoCheckFiredOnce.current = true;
      void runCheck("auto");
    }
    // Menu "アップデートを確認..." (emitted to the focused window only).
    unlisten = await win.listen(CHECK_FOR_UPDATES_EVENT, () => void runCheck("manual"));
  });
  onBeforeUnmount(() => unlisten?.());

  return { state, checkManually: () => runCheck("manual"), installAndRestart, dismiss };
}
