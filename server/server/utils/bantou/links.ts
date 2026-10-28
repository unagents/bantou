import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isValidAgentId } from "@agent-hand/bantou-protocol";

/** worker の所有 cap を残すファイル（`workers/<id>/`）。 */
export const OWNER_FILE = "owner.json";
/** kick_cap の送り主を残すファイル（`caps/<id>/`）。 */
export const REPLY_TO_FILE = "reply_to.json";

export interface OwnerFile {
  cap_id: string;
}

export interface ReplyToFile {
  /** messenger の peer id。返信先。 */
  id: string;
  name: string;
}

/** dir/name へ JSON を原子的に書く。 */
export async function writeJsonFile(dir: string, name: string, data: unknown): Promise<void> {
  await mkdir(dir, { recursive: true });
  const tmp = join(dir, `.${name}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`);
  try {
    await writeFile(tmp, JSON.stringify(data, null, 2) + "\n");
    await rename(tmp, join(dir, name));
  } catch (e) {
    await unlink(tmp).catch(() => {});
    throw e;
  }
}

async function readJsonFile(dir: string, name: string): Promise<Record<string, unknown> | null> {
  let raw: string;
  try {
    raw = await readFile(join(dir, name), "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error(`${name} を読めない: ${join(dir, name)} (${(e as Error).message})`);
  }
  let d: unknown;
  try {
    d = JSON.parse(raw);
  } catch (e) {
    throw new Error(`${name} が JSON として不正: ${join(dir, name)} (${(e as Error).message})`);
  }
  if (typeof d !== "object" || d === null || Array.isArray(d)) {
    throw new Error(`${name} の形が不正: ${join(dir, name)}`);
  }
  return d as Record<string, unknown>;
}

/** worker dir の owner.json から cap_id を返す。無ければ null、壊れていれば投げる。 */
export async function readOwner(workerDir: string): Promise<string | null> {
  const d = await readJsonFile(workerDir, OWNER_FILE);
  if (d === null) return null;
  if (!isValidAgentId(d.cap_id)) throw new Error(`${OWNER_FILE} の cap_id が不正: ${join(workerDir, OWNER_FILE)}`);
  return d.cap_id;
}

/** cap dir の reply_to.json を返す。無ければ null、壊れていれば投げる。 */
export async function readReplyTo(capDir: string): Promise<ReplyToFile | null> {
  const d = await readJsonFile(capDir, REPLY_TO_FILE);
  if (d === null) return null;
  if (typeof d.id !== "string" || d.id === "" || typeof d.name !== "string") {
    throw new Error(`${REPLY_TO_FILE} の形が不正: ${join(capDir, REPLY_TO_FILE)}`);
  }
  return { id: d.id, name: d.name };
}
