export const LOCK_FILE: string;
export const READY_FILE: string;
export const UPDATE_FILE: string;
export const READY_TIMEOUT_MS: number;
export function isAlive(pid: number): boolean;
export function readWorkspace(configPath: string): string;
export function acquireLock(workspace: string, version: string, pid?: number): () => void;
export function assertServeAllowed(workspace: string, env?: Record<string, string | undefined>): void;
export function defaultCommand(selfBin: string, configPath: string): (spec: string | null) => { cmd: string; args: string[] };
export interface SupervisorOptions {
  configPath: string;
  selfBin: string;
  version: string;
  command?: (spec: string | null) => { cmd: string; args: string[] };
  readyTimeoutMs?: number;
  log?: (msg: string) => void;
  pid?: number;
  env?: Record<string, string | undefined>;
}
export function runSupervisor(opts: SupervisorOptions): Promise<number>;
