import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { isValidAgentId, type AgentKind } from "@agent-hand/bantou-protocol";

/** cap / worker の作業ディレクトリ。id が不正なら投げる。 */
export function agentDir(workspace: string, kind: AgentKind, id: string): string {
  if (!isValidAgentId(id)) {
    throw new Error(kind === "cap" ? `cap_id が不正: ${id}` : `worker_id が不正: ${id}`);
  }
  return join(workspace, kind === "cap" ? "caps" : "workers", id);
}

/** 状態ファイル。 */
export function stateFile(dir: string): string {
  return join(dir, "state.json");
}

/** 実行ログのディレクトリ。 */
export function runLogDir(dir: string): string {
  return join(dir, "logs");
}

/** 掃除済みの印（logs/ の中）。再開時の clone し直しの判定に使う。 */
export function cleanedFile(dir: string): string {
  return join(runLogDir(dir), "cleaned.json");
}

/** 掃除しても残すもの（dir 直下）。 */
export const KEEP_ENTRIES: readonly string[] = ["logs", "state.json"];

/** dir 直下の logs/ と state.json 以外を消す（.git を最初に）。消した件数を返す。 */
export async function removeNonKept(dir: string): Promise<number> {
  const names = (await readdir(dir)).filter((n) => !KEEP_ENTRIES.includes(n)).sort((a, b) => (a === ".git" ? -1 : b === ".git" ? 1 : 0));
  for (const name of names) await rm(join(dir, name), { recursive: true, force: true });
  return names.length;
}
