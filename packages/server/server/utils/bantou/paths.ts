import { chmod, lstat, mkdir, unlink } from "node:fs/promises";
import { join } from "node:path";

/** worker の id。作業 dir の名前になる（server が作る）。 */
export const WORKER_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

export function isValidWorkerId(v: unknown): v is string {
  return typeof v === "string" && WORKER_ID_PATTERN.test(v);
}

/** worker の作業ディレクトリ。id が不正なら投げる。 */
export function workerDir(workspace: string, id: string): string {
  if (!isValidWorkerId(id)) throw new Error(`worker_id が不正: ${id}`);
  return join(workspace, "workers", id);
}

/** 状態ファイル。 */
export function stateFile(dir: string): string {
  return join(dir, "state.json");
}

/** 実行ログのディレクトリ。 */
export function runLogDir(dir: string): string {
  return join(dir, "logs");
}

/** 掃除しても残すもの（dir 直下）。bash の rm もこれを消さない。 */
export const KEEP_ENTRIES: readonly string[] = ["logs", "state.json"];

/** worker の TMPDIR（dir 直下の tmp/）。 */
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
    if ((e as NodeJS.ErrnoException).code !== "EEXIST" || !(await lstat(tmp)).isDirectory()) throw e;
    return tmp;
  }
  await chmod(tmp, 0o700); // umask に左右されない
  return tmp;
}
