import { invoke } from "@tauri-apps/api/core";
import type { CenterSettings, CenterStatus } from "~/types";

export const centerGetSettings = () => invoke<CenterSettings>("center_get_settings");

export const centerSetSettings = (settings: CenterSettings) =>
  invoke<CenterSettings>("center_set_settings", { settings });

export const centerStatus = () => invoke<CenterStatus>("center_status");
