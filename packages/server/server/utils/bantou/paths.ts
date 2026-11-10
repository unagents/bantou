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
 * tmp/ を無ければ mode 700 で作る。在れば何も作らないが、自分の所有で 700 より緩い（group / other に権限がある）時は 700 に戻す。
 * tmp が dir でない（symlink・file）時は TMPDIR が自分の path の外を指しうるので、それ自体を消して作り直す。
 * 返り値は tmp/ の path。
 */
export async function ensureTmpDir(dir: string): Promise<string> {
  const tmp = tmpDir(dir);
  try {
    const st = await lstat(tmp);
    if (st.isDirectory()) {
      // 所有者が自分で、group / other に権限が付いている時だけ 700 に戻す
      if (st.uid === process.getuid?.() && (st.mode & 0o077) !== 0) await chmod(tmp, 0o700);
      return tmp;
    }
    await unlink(tmp);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  await mkdir(tmp, { mode: 0o700 });
  await chmod(tmp, 0o700); // umask に左右されない
  return tmp;
}
