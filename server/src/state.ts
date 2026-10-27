import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { isAgentState, type AgentState } from "@agent-hand/bantou-protocol";
import { stateFile } from "./paths.js";

export interface AgentStateFile {
  session_id: string | null;
  state: AgentState;
  last_started_at: string | null;
  last_finished_at: string | null;
  last_error?: string;
  retries: number;
}

function emptyState(): AgentStateFile {
  return { session_id: null, state: "idle", last_started_at: null, last_finished_at: null, retries: 0 };
}

const isNullableString = (v: unknown): v is string | null => v === null || typeof v === "string";

/** state.json を読む。無ければ既定値、壊れていれば path 付きで投げる。 */
export async function readState(dir: string): Promise<AgentStateFile> {
  const path = stateFile(dir);
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return emptyState();
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
    !isNullableString(o.session_id) ||
    !isAgentState(o.state) ||
    !isNullableString(o.last_started_at) ||
    !isNullableString(o.last_finished_at) ||
    (o.last_error !== undefined && typeof o.last_error !== "string") ||
    typeof o.retries !== "number" || !Number.isInteger(o.retries)
  ) {
    throw new Error(`state の形が不正: ${path}`);
  }
  const s: AgentStateFile = {
    session_id: o.session_id,
    state: o.state,
    last_started_at: o.last_started_at,
    last_finished_at: o.last_finished_at,
    retries: o.retries,
  };
  if (o.last_error !== undefined) s.last_error = o.last_error;
  return s;
}

/** state.json を原子的に書く（tmp に書いて rename）。 */
export async function writeState(dir: string, state: AgentStateFile): Promise<void> {
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
