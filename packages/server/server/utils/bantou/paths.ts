import { chmod, lstat, mkdir, readdir, rm, unlink } from "node:fs/promises";
import { join } from "node:path";
import { isValidAgentId, type AgentKind } from "@agent-hand/bantou-protocol";

/** cap / worker の作業ディレクトリ。id が不正なら投げる。 */
export function agentDir(workspace: string, kind: AgentKind, id: string): string {
  if (!isValidAgentId(id)) {
    throw new Error(kind === "cap" ? `cap_id が不正: ${id}` : `worker_id が不正: ${id}`);
  }
  return join(workspace, kind === "cap" ? "caps" : "workers", id);
}

/**
 * cap の task ごとの指揮の会話（lane）の記録の置き場。cap の logs/ の中（cap 自身の bash の rm では消せない）。
 * lane の claude は cap の dir を cwd にして動き、state.json・logs/（会話の生出力・mcp.json など）だけをここに持つ。
 */
export function laneRoot(capDir: string): string {
  return join(runLogDir(capDir), "tasks");
}

/** task_id の lane の dir。task_id が不正なら投げる。 */
export function laneDir(workspace: string, capId: string, taskId: string): string {
  if (!isValidAgentId(taskId)) throw new Error(`task_id が不正: ${taskId}`);
  return join(laneRoot(agentDir(workspace, "cap", capId)), taskId);
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

/** cap / worker の TMPDIR（dir 直下の tmp/）。 */
export function tmpDir(dir: string): string {
  return join(dir, "tmp");
}

/**
 * tmp/ を無ければ mode 700 で作る（在れば何もしない。mode は保つ）。
 * tmp が dir でない（symlink・file）時は TMPDIR が自分の path の外を指しうるので、それ自体を消して作り直す。
 * 返り値は tmp/ の path。
 */
export async function ensureTmpDir(dir: string): Promise<string> {
  const tmp = tmpDir(dir);
  try {
    if ((await lstat(tmp)).isDirectory()) return tmp;
    await unlink(tmp);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  try {
    await mkdir(tmp, { mode: 0o700 });
  } catch (e) {
    // 同じ cap の task の指揮（lane）が同時に作った: dir なら使う（symlink などなら投げる）
    if ((e as NodeJS.ErrnoException).code !== "EEXIST" || !(await lstat(tmp)).isDirectory()) throw e;
    return tmp;
  }
  await chmod(tmp, 0o700); // umask に左右されない
  return tmp;
}
