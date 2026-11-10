import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { hostname, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { SERVER_ID_PATTERN, type ServerIdentityFields } from "@agent-hand/bantou-protocol";

/** server の安定 id の保存先（workspace 直下）。caps/workers の state.json とは別ファイル。 */
export const SERVER_FILE = "server.json";

export const serverFile = (workspace: string): string => join(workspace, SERVER_FILE);

/** `srv-` + 乱数 10 桁 hex。利用者が打っても扱える短さにする。 */
export function generateServerId(): string {
  return `srv-${randomBytes(5).toString("hex")}`;
}

async function writeAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${randomBytes(3).toString("hex")}.tmp`;
  try {
    await writeFile(tmp, JSON.stringify(value, null, 2) + "\n");
    await rename(tmp, path);
  } catch (e) {
    await unlink(tmp).catch(() => {});
    throw e;
  }
}

/**
 * workspace の server_id を返す。無ければ（初回・旧形式の server.json・壊れた/読めない server.json）生成して保存する。
 * - 初回: server.json を作る。
 * - server_id の無い旧形式（他のキーだけ）: 他のキーを残して server_id を足す。
 * - 壊れている（JSON 不正・形が不正・server_id が不正）: 再生成して上書きする（log に残す）。id が変わる代わりに起動を止めない。
 * - 保存に失敗: 起動を止めず、その起動だけの id を返す（log に残す。次の起動で再び生成を試みる）。
 */
export async function loadOrCreateServerId(workspace: string, log: (msg: string) => void = () => {}): Promise<string> {
  const path = serverFile(workspace);
  let base: Record<string, unknown> = {};
  let reason: string;
  try {
    const raw = await readFile(path, "utf8");
    try {
      const d: unknown = JSON.parse(raw);
      if (typeof d !== "object" || d === null || Array.isArray(d)) {
        reason = "形が不正";
      } else {
        const o = d as Record<string, unknown>;
        if (typeof o.server_id === "string" && SERVER_ID_PATTERN.test(o.server_id)) return o.server_id;
        if (o.server_id === undefined) {
          base = o;
          reason = "server_id が無い（旧形式）";
        } else {
          reason = "server_id が不正";
        }
      }
    } catch {
      reason = "JSON として不正";
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") reason = "初回";
    else reason = `読めない (${(e as Error).message})`;
  }
  const server_id = generateServerId();
  try {
    await writeAtomic(path, { ...base, server_id, created_at: new Date().toISOString() });
    log(`server_id 生成: ${server_id} (${reason}) path=${path}`);
  } catch (e) {
    log(`server_id を保存できない（この起動だけの id を使う）: ${server_id} path=${path} ${(e as Error).message}`);
  }
  return server_id;
}

function currentUser(): string {
  try {
    return userInfo().username;
  } catch {
    return process.env.USER ?? process.env.LOGNAME ?? "unknown";
  }
}

/** hello_result / status_result に載せる identity。host / user は取れた時点の値。 */
export function buildIdentity(serverId: string, workspace: string): Required<ServerIdentityFields> {
  return { server_id: serverId, host: hostname(), user: currentUser(), workspace };
}
