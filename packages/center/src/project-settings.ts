import { z } from "zod";
import { SESSION_INSTRUCTIONS_MAX } from "./config.js";

/**
 * プロジェクト（session）ごとの設定。sessions.json の各 session の `settings` に保存する。
 * 既知の項目は検証し、未知の項目は JSON のまま保持する（将来の項目を足しても古い center が消さない）。
 */
export interface ProjectSettings {
  /** master-cap の追加指示。起動のたびに `--append-system-prompt <値>` で渡す。 */
  instructions?: string;
  [key: string]: unknown;
}

/** 更新の入力。項目ごとに省略可。null はその項目を削除する。未知の項目は素通しする。 */
export const projectSettingsPatchSchema = z
  .object({
    instructions: z.string().max(SESSION_INSTRUCTIONS_MAX, `${SESSION_INSTRUCTIONS_MAX} 文字以内`).nullable().optional(),
  })
  .passthrough();

export type ProjectSettingsPatch = z.infer<typeof projectSettingsPatchSchema>;

/**
 * patch を current に重ねた新しい settings を返す（current は変えない）。
 * - patch に無い（undefined）項目は変えない。
 * - null はその項目を削除する。`instructions` の空文字も削除と同じ（保存しない）。
 * - 未知の項目は値をそのまま入れる。
 */
export function mergeSettings(current: ProjectSettings | undefined, patch: ProjectSettingsPatch): ProjectSettings {
  const out: ProjectSettings = { ...(current ?? {}) };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    if (v === null || (k === "instructions" && v === "")) delete out[k];
    else out[k] = v;
  }
  return out;
}

/** 保存済みの値（sessions.json 由来。壊れていても落とさない）から settings を取り出す。 */
export function readSettings(raw: unknown): ProjectSettings {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
  const out: ProjectSettings = { ...(raw as Record<string, unknown>) };
  if (typeof out.instructions !== "string" || out.instructions === "") delete out.instructions;
  return out;
}
