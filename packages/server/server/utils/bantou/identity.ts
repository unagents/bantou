import { randomBytes } from "node:crypto";
import { link, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
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

/**
 * tmp に書いてから置く。exclusive=true は link（先勝ち。既にあれば EEXIST、中身が揃ってから見える）、false は rename（上書き）。
 * server.json は secret を含まない。default の mode（umask 次第で 0644）のままで、読み取り可でよい。
 */
async function writeAtomic(path: string, value: unknown, exclusive: boolean): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${randomBytes(3).toString("hex")}.tmp`;
  try {
    await writeFile(tmp, JSON.stringify(value, null, 2) + "\n");
    if (exclusive) await link(tmp, path);
    else await rename(tmp, path);
  } finally {
    await unlink(tmp).catch(() => {});
  }
}

/** server.json の server_id を読む。無い・不正なら undefined と理由・引き継ぐ他のキーを返す。 */
async function readServerId(path: string): Promise<{ id?: string; base: Record<string, unknown>; reason: string; missing: boolean }> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { base: {}, reason: "初回", missing: true };
    return { base: {}, reason: `読めない (${(e as Error).message})`, missing: false };
  }
  let d: unknown;
  try {
    d = JSON.parse(raw);
  } catch {
    return { base: {}, reason: "JSON として不正", missing: false };
  }
  if (typeof d !== "object" || d === null || Array.isArray(d)) return { base: {}, reason: "形が不正", missing: false };
  const o = d as Record<string, unknown>;
  if (typeof o.server_id === "string" && SERVER_ID_PATTERN.test(o.server_id)) return { id: o.server_id, base: o, reason: "", missing: false };
  if (o.server_id === undefined) return { base: o, reason: "server_id が無い（旧形式）", missing: false };
  return { base: {}, reason: "server_id が不正", missing: false };
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
  const cur = await readServerId(path);
  if (cur.id) return cur.id;
  const server_id = generateServerId();
  try {
    // 初回は先勝ち（link）: 並行して起動した別プロセスに負けたら、勝者の id を読み直してそれを使う（再起動後に id が変わらない）
    if (cur.missing) {
      try {
        await writeAtomic(path, { server_id, created_at: new Date().toISOString() }, true);
        log(`server_id 生成: ${server_id} (${cur.reason}) path=${path}`);
        return server_id;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
        const winner = await readServerId(path);
        if (winner.id) return winner.id;
        // 勝者のファイルが不正（通常は起きない）なら、下で上書きする
        cur.reason = winner.reason;
        cur.base = winner.base;
      }
    }
    await writeAtomic(path, { ...cur.base, server_id, created_at: new Date().toISOString() }, false);
    log(`server_id 生成: ${server_id} (${cur.reason}) path=${path}`);
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
