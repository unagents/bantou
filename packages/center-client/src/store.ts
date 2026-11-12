/** Where the settings live. Web: a file (`createFileSettingsStore`). Desktop (later): the tauri store. */
export interface SettingsStore {
  /** The stored value as is. `undefined`: nothing stored. */
  read(): Promise<unknown | undefined>;
  write(value: unknown): Promise<void>;
}
