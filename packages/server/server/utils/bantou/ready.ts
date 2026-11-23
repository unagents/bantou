import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/** supervisor との取り決めのファイル名（bin/supervisor.mjs と同じ）。起動できた合図。 */
export const READY_FILE = "server.ready";

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(value) + "\n");
  await rename(tmp, path);
}

export async function writeReadyFile(workspace: string, version: string): Promise<void> {
  await writeJsonAtomic(join(workspace, READY_FILE), { pid: process.pid, version });
}

export async function removeReadyFile(workspace: string): Promise<void> {
  const path = join(workspace, READY_FILE);
  try {
    const cur = JSON.parse(await readFile(path, "utf8")) as { pid?: unknown };
    if (cur.pid === process.pid) await rm(path, { force: true });
  } catch {
    // 無ければよい
  }
}
