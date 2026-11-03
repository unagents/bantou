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

/** session 名の最大文字数（cap_id のディレクトリ名を 255 byte に収める）。 */
export const MAX_SESSION_NAME = 64;

/**
 * session の cap_id。`<center の cap_id>-<session 名>`（例 `c-0a1b2c3d4e-main`）。cap は session × server に 1 つ。
 * session 名は cap_id と同じ文字種（`[A-Za-z0-9_-]`、sessions.ts の SESSION_NAME）なので、変換は恒等（エスケープ不要）。
 * center の cap_id は固定長（`c-` + 10 桁 hex）で `-` の位置が決まるので、session 名が違えば cap_id も必ず違い、
 * 旧共有 cap（`c-<center-id>`）とも一致しない。文字種に合わない名前、`MAX_SESSION_NAME`（64）文字を超える名前は投げる（黙って別の名前に寄せない・短縮しない）。
 * 上限の理由: cap_id は `<workspace>/caps/<cap_id>` のディレクトリ名になる（Linux は 255 byte まで）。server の検証（AGENT_ID_PATTERN）に長さ上限は無いので center 側で絞る。cap_id は最大 13 + 64 = 77 文字。
 */
export function sessionCapId(centerCapId: string, session: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(session)) throw new Error("session 名は英数字と _ - のみ");
  if (session.length > MAX_SESSION_NAME) throw new Error(`session 名は ${MAX_SESSION_NAME} 文字まで`);
  return `${centerCapId}-${session}`;
}
