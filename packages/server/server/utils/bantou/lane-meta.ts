import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * cap の task の lane の記録（lane の dir の task.json）。task_id・branch（同じ branch の待ちの引き継ぎ）・受けた時刻と、
 * task の最初の指示の文面（会話が失われた lane を再開する時に再掲する。repo の URL に認証情報が含まれうるので本人だけが読める）。
 */
export interface LaneMeta {
  task_id: string;
  branch?: string;
  queued_at: string;
  prompt?: string;
}

export const laneMetaFile = (laneDir: string): string => join(laneDir, "task.json");

export async function writeLaneMeta(laneDir: string, meta: LaneMeta): Promise<void> {
  await mkdir(laneDir, { recursive: true });
  await writeFile(laneMetaFile(laneDir), JSON.stringify(meta) + "\n", { mode: 0o600 });
}

/** 無い・壊れている時は undefined。 */
export async function readLaneMeta(laneDir: string): Promise<LaneMeta | undefined> {
  try {
    const d = JSON.parse(await readFile(laneMetaFile(laneDir), "utf8")) as Record<string, unknown>;
    if (typeof d.task_id !== "string" || typeof d.queued_at !== "string") return undefined;
    return {
      task_id: d.task_id,
      queued_at: d.queued_at,
      ...(typeof d.branch === "string" && d.branch !== "" ? { branch: d.branch } : {}),
      ...(typeof d.prompt === "string" && d.prompt !== "" ? { prompt: d.prompt } : {}),
    };
  } catch {
    return undefined;
  }
}
