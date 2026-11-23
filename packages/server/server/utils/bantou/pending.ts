import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { isSchemaDiscovery } from "@agent-hand/bantou-protocol";
import { isValidWorkerId, workerDir } from "./paths";
import type { Job } from "./queue";
import type { WorkerRunInput } from "./worker";

/** 自己更新の再起動をまたいで続ける、queue で待っている launch / reply を持つ file（<workspace> 直下）。 */
export const PENDING_FILE = "pending-jobs.json";

export interface PendingJob {
  kind: "launch" | "reply";
  input: WorkerRunInput;
}

const isStr = (v: unknown): v is string => typeof v === "string" && v.length > 0;

function parseJob(v: unknown): PendingJob | undefined {
  if (typeof v !== "object" || v === null) return undefined;
  const o = v as { kind?: unknown; input?: unknown };
  const i = o.input as Record<string, unknown> | null | undefined;
  if ((o.kind !== "launch" && o.kind !== "reply") || typeof i !== "object" || i === null) return undefined;
  if (
    !isStr(i.workerId) || !isStr(i.dir) || !isStr(i.parentId) || !isStr(i.ws) || !isStr(i.sessionId) || typeof i.prompt !== "string" ||
    (i.mode !== "new" && i.mode !== "resume") ||
    (i.model !== undefined && !isStr(i.model)) ||
    (i.schema !== undefined && !isSchemaDiscovery(i.schema))
  ) {
    return undefined;
  }
  return { kind: o.kind, input: i as unknown as WorkerRunInput };
}

/** 待っている Job を file に書く（原子的）。ws の token・schema の認証の値が生で入るので本人だけが読める mode（0600）。 */
export async function writePending(workspace: string, jobs: Job[]): Promise<number> {
  const items: PendingJob[] = jobs.flatMap((j) => (j.input !== undefined ? [{ kind: j.kind, input: j.input }] : []));
  const path = join(workspace, PENDING_FILE);
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify({ jobs: items }) + "\n", { mode: 0o600 });
  await rename(tmp, path);
  return items.length;
}

/** file から読み、file を消す（読めた分だけ返す。壊れた項目は読み飛ばす）。無ければ空。 */
export async function takePending(workspace: string): Promise<{ jobs: PendingJob[]; skipped: number }> {
  const path = join(workspace, PENDING_FILE);
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return { jobs: [], skipped: 0 };
  }
  await rm(path, { force: true });
  let list: unknown[] = [];
  try {
    const d = JSON.parse(raw) as { jobs?: unknown };
    if (Array.isArray(d.jobs)) list = d.jobs;
  } catch {
    return { jobs: [], skipped: 1 };
  }
  const jobs = list.flatMap((x) => {
    const j = parseJob(x);
    // dir は worker id から導いた物だけ（file が書き換えられても workspace の外を作業 dir にしない）
    return j && isValidWorkerId(j.input.workerId) && j.input.dir === workerDir(workspace, j.input.workerId) ? [j] : [];
  });
  return { jobs, skipped: list.length - jobs.length };
}

/** 更新を取りやめた時などに file を消す。 */
export async function clearPending(workspace: string): Promise<void> {
  await rm(join(workspace, PENDING_FILE), { force: true });
}
