import { openUrl } from "@tauri-apps/plugin-opener";
import { relaunch } from "@tauri-apps/plugin-process";
import { check, type Update } from "@tauri-apps/plugin-updater";

// Thin wrappers over `@tauri-apps/plugin-updater` / `plugin-process`. The
// version comparison and the bundle replacement both happen inside the
// plugins; bantou keeps no updater settings of its own (auto-check is always
// on, same as Cork).

/** Emitted by the app menu "アップデートを確認..." (`src-tauri/src/menu.rs`), scoped to the focused window. */
export const CHECK_FOR_UPDATES_EVENT = "menu:check-for-updates";

export const checkForUpdate = (): Promise<Update | null> => check();

export type DownloadProgress = Parameters<Update["downloadAndInstall"]>[0] extends
  | ((event: infer E) => void)
  | undefined
  | null
  ? E
  : never;

export const downloadAndInstall = (
  update: Update,
  onProgress?: (event: DownloadProgress) => void,
): Promise<void> => update.downloadAndInstall(onProgress);

export const relaunchApp = (): Promise<void> => relaunch();

/** Opens the GitHub release page of `version` in the default browser. */
export const openReleaseNotes = (version: string): Promise<void> =>
  openUrl(`https://github.com/unagents/bantou/releases/tag/v${version}`);

export type { Update };
