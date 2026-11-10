export interface LauncherOptions {
  configPath: string;
  selfBin: string;
  pollMs?: number;
  pid?: number;
  env?: Record<string, string | undefined>;
  log?: (msg: string) => void;
}
export function workspaceOf(configPath: string): string;
export function runLauncher(opts: LauncherOptions): Promise<number>;
