import { centerGetSettings, centerLauncher } from "../api";
import type { CenterSettings } from "../types";

/**
 * This desktop runs no sidecar of its own and talks to another host's center: center off with a remote set.
 * Pass the SAVED settings (what `center_get_settings` returned), not a draft being edited.
 * The one rule for "is the sidecar running here": `enabled` starts the sidecar and picks the target
 * (center_mcp.rs::select_target). Off without a remote (nothing connected yet) is not this case.
 */
export const isRemoteOnly = (s: Pick<CenterSettings, "enabled" | "remote">): boolean => !s.enabled && !!s.remote;

/**
 * Whether the reference-folder rows (`addDirs`) are left out of a settings form. They are paths on the
 * center's host, picked with this PC's folder dialog: meaningful for the own sidecar only.
 * Hidden until the saved settings are read (no flash of the rows); a failed read shows them (as before).
 */
export function useHideAddDirs() {
  const hideAddDirs = ref(true);
  async function refresh() {
    hideAddDirs.value = true;
    try {
      hideAddDirs.value = isRemoteOnly(await centerGetSettings());
    } catch {
      hideAddDirs.value = false;
    }
  }
  return { hideAddDirs, refresh };
}

/**
 * Whether this screen is the place that started the connected center (the desktop running it as its sidecar): only that
 * place reads and writes the center-internal settings (extra MCP servers `mcpServers`, external memory `memory`). The center
 * tells it (`centerInfo.launcher`, from the key the desktop gives its sidecar); a desktop connected to another
 * host's center and the web get false. False until read, and on a failed read (the fields stay hidden).
 */
export function useCenterLauncher() {
  const launcher = ref(false);
  async function refresh() {
    launcher.value = false;
    try {
      launcher.value = await centerLauncher();
    } catch {
      launcher.value = false;
    }
  }
  return { launcher, refresh };
}
