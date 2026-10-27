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
