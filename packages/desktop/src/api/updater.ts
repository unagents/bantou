import { getPlatform, type DownloadProgress, type Update } from "~/tauri";

// Thin wrappers over the platform's updater / relaunch (the Tauri updater / process plugins on desktop, see `~/tauri`).
// The version comparison and the bundle replacement both happen inside the
// plugins; bantou keeps no updater settings of its own (auto-check is always
// on, same as Cork).

/** Emitted by the app menu "アップデートを確認..." (`src-tauri/src/menu.rs`), scoped to the focused window. */
export const CHECK_FOR_UPDATES_EVENT = "menu:check-for-updates";

export const checkForUpdate = (): Promise<Update | null> => getPlatform().checkForUpdate();

export const downloadAndInstall = (
  update: Update,
  onProgress?: (event: DownloadProgress) => void,
): Promise<void> => getPlatform().downloadAndInstall(update, onProgress);

export const relaunchApp = (): Promise<void> => getPlatform().relaunch();

export type { DownloadProgress, Update };
