import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runLogDir } from "./paths";

/** claude の --model にそのまま渡す値の形式。 */
/** 先頭 - 不可（引数として解釈されるのを防ぐ）。protocol の MODEL_PATTERN と同じ。 */
export const MODEL_PATTERN = /^[A-Za-z0-9._[\]][A-Za-z0-9._[\]-]*$/;

/** model 文字列の検証。不正なら投げる。 */
export function assertModel(v: unknown, field = "model"): string {
  if (typeof v !== "string" || !MODEL_PATTERN.test(v)) {
    throw new Error(`${field} が不正（${MODEL_PATTERN} に合う文字列）: ${String(v)}`);
  }
  return v;
}

/**
 * AgentActivity に model を足した型。protocol が model を持つ版でも持たない版でも通る
 * （古い protocol の型には無い項目なので、交差で足す。受け側が知らなければ無視される）。
 */
export type WithModel<T> = T & { model?: string | null };

/** agent ごとに覚えるモデル。model = そのエージェント自身、worker_model = cap が起動する worker の既定。 */
export interface ModelRecord {
  model?: string;
  worker_model?: string;
}

const modelFile = (dir: string): string => join(runLogDir(dir), "model.json");

/** 記録を読む。無い・壊れている・不正な値は無視する（省略 = --model を付けない）。 */
export async function readModelRecord(dir: string): Promise<ModelRecord> {
  try {
    const d = JSON.parse(await readFile(modelFile(dir), "utf8")) as Record<string, unknown>;
    const out: ModelRecord = {};
    if (typeof d.model === "string" && MODEL_PATTERN.test(d.model)) out.model = d.model;
    if (typeof d.worker_model === "string" && MODEL_PATTERN.test(d.worker_model)) out.worker_model = d.worker_model;
    return out;
  } catch {
    return {};
  }
}

/** 指定があった項目だけ上書きして保存する。 */
export async function writeModelRecord(dir: string, patch: ModelRecord): Promise<ModelRecord> {
  const next: ModelRecord = { ...(await readModelRecord(dir)) };
  if (patch.model !== undefined) next.model = patch.model;
  if (patch.worker_model !== undefined) next.worker_model = patch.worker_model;
  await mkdir(runLogDir(dir), { recursive: true });
  await writeFile(modelFile(dir), JSON.stringify(next) + "\n");
  return next;
}
