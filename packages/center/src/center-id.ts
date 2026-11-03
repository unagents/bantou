import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { AGENT_ID_PATTERN } from "@agent-hand/bantou-protocol";

/** center の安定 id を保存するファイル名（config と同じ dir）。 */
export const CENTER_ID_FILE = "center-id";

/** remote-cap の cap_id 接頭辞。cap_id = `c-<center の安定 id>`。 */
export const CAP_ID_PREFIX = "c-";

/**
 * center ごとに固定の cap_id を返す。center の状態 dir（config と同じ場所）の `center-id` に 10 桁 hex を持ち、
 * 無ければ作る。center を再起動しても同じ値になる（dir ごと消えない限り）。
 * 書けない時は、この起動の間だけの id を返す（ログに残す。再起動で変わるので、server に前の cap が残る）。
 */
export async function loadCapId(stateDir: string, log: (m: string) => void): Promise<string> {
  const path = join(stateDir, CENTER_ID_FILE);
  try {
    const id = (await readFile(path, "utf8")).trim();
    const capId = `${CAP_ID_PREFIX}${id}`;
    if (/^[0-9a-f]{10}$/.test(id) && AGENT_ID_PATTERN.test(capId)) return capId;
    log(`center-id が不正（作り直す）: ${path}`);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") log(`center-id を読めない（作り直す）: ${path} ${(e as Error).message}`);
  }
  const id = randomBytes(5).toString("hex");
  try {
    await mkdir(stateDir, { recursive: true });
    await writeFile(path, `${id}\n`, { mode: 0o600 });
  } catch (e) {
    log(`center-id を保存できない（この起動の間だけ有効）: ${path} ${(e as Error).message}`);
  }
  return `${CAP_ID_PREFIX}${id}`;
}
