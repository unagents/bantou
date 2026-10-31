export const LOCK_FILE: string;
export const READY_FILE: string;
export const UPDATE_FILE: string;
export const EXIT_FILE: string;
export const HANDOFF_SLACK_MS: number;
export const READY_TIMEOUT_MS: number;
export function isAlive(pid: number): boolean;
export function readWorkspace(configPath: string): string;
export interface LockNext {
  token: string;
  pid?: number;
  version?: string;
  child?: number;
  ready?: boolean;
}
export interface LockFile {
  pid: number;
  version: string;
  started_at: string;
  launcher?: number;
  child?: number;
  next?: LockNext;
}
export function readLock(workspace: string): LockFile | undefined;
export function writeLock(workspace: string, lock: LockFile): void;
export function acquireLock(workspace: string, version: string, pid?: number, launcher?: number): () => void;
export function assertServeAllowed(workspace: string, env?: Record<string, string | undefined>): void;
export function defaultCommand(selfBin: string, configPath: string): (spec: string | null) => { cmd: string; args: string[] };
export function defaultNextCommand(configPath: string): (spec: string) => { cmd: string; args: string[] };
export function defaultProbe(spec: string, env?: Record<string, string | undefined>): Promise<boolean>;
export interface SupervisorOptions {
  configPath: string;
  selfBin: string;
  version: string;
  command?: (spec: string | null) => { cmd: string; args: string[] };
  readyTimeoutMs?: number;
  log?: (msg: string) => void;
  pid?: number;
  env?: Record<string, string | undefined>;
  launcher?: number;
  handoffToken?: string;
  handoff?: boolean;
  probe?: (spec: string) => Promise<boolean>;
  nextCommand?: (spec: string) => { cmd: string; args: string[] };
  handoffSlackMs?: number;
}
export function runSupervisor(opts: SupervisorOptions): Promise<number>;
