import { randomBytes } from "node:crypto";
import { mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isValidWorkerId, stateFile, workerDir } from "./paths";

/**
 * worker の dir の state.json。reply（session-id で起こし直す）が、その worker の dir・cap の名前・ws・model を引くための記録。
 * cap へ返す message の session-id はここからは取らない（最後の result から取る）。
 */
export interface WorkerState {
  worker_id: string;
  session_id: string;
  /** 起こした cap の名前（launch の parent-id）。 */
  parent_id: string;
  /** launch の ws。 */
  ws: string;
  /** launch の model。省略されたら無し（--model を付けない）。 */
  model?: string;
  last_started_at: string | null;
  last_finished_at: string | null;
}

const isString = (v: unknown): v is string => typeof v === "string" && v.length > 0;
const isNullableString = (v: unknown): v is string | null => v === null || typeof v === "string";

/** state.json を読む。無ければ undefined、壊れていれば path 付きで投げる。 */
export async function readState(dir: string): Promise<WorkerState | undefined> {
  const path = stateFile(dir);
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error(`state を読めない: ${path} (${(e as Error).message})`);
  }
  let d: unknown;
  try {
    d = JSON.parse(raw);
  } catch (e) {
    throw new Error(`state が JSON として不正: ${path} (${(e as Error).message})`);
  }
  const o = d as Record<string, unknown> | null;
  if (
    typeof o !== "object" || o === null || Array.isArray(o) ||
    !isString(o.worker_id) ||
    !isString(o.session_id) ||
    !isString(o.parent_id) ||
    !isString(o.ws) ||
    (o.model !== undefined && !isString(o.model)) ||
    !isNullableString(o.last_started_at) ||
    !isNullableString(o.last_finished_at)
  ) {
    throw new Error(`state の形が不正: ${path}`);
  }
  return {
    worker_id: o.worker_id,
    session_id: o.session_id,
    parent_id: o.parent_id,
    ws: o.ws,
    ...(o.model !== undefined ? { model: o.model } : {}),
    last_started_at: o.last_started_at,
    last_finished_at: o.last_finished_at,
  };
}

/** state.json を原子的に書く（tmp に書いて rename）。 */
export async function writeState(dir: string, state: WorkerState): Promise<void> {
  await mkdir(dir, { recursive: true });
  const tmp = join(dir, `.state.json.tmp-${process.pid}-${randomBytes(4).toString("hex")}`);
  try {
    await writeFile(tmp, JSON.stringify(state, null, 2) + "\n");
    await rename(tmp, stateFile(dir));
  } catch (e) {
    await unlink(tmp).catch(() => {});
    throw e;
  }
}

/** session-id の worker を、workers/ 配下の state.json から探す。無ければ undefined（壊れた state は読み飛ばす）。 */
export async function findWorkerBySession(workspace: string, sessionId: string): Promise<{ dir: string; state: WorkerState } | undefined> {
  let names: string[];
  try {
    names = await readdir(join(workspace, "workers"));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw e;
  }
  for (const name of names) {
    if (!isValidWorkerId(name)) continue;
    const dir = workerDir(workspace, name);
    const state = await readState(dir).catch(() => undefined);
    if (state !== undefined && state.session_id === sessionId) return { dir, state };
  }
  return undefined;
}
