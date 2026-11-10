import { lstat, realpath, rm, unlink } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { isValidAgentId } from "@agent-hand/bantou-protocol";
import { KEEP_ENTRIES, agentDir } from "./paths";
import { readOwner } from "./workers";

/**
 * MCP tool `bash`。任意のシェル文字列は受けず、action ごとの handler 表にある操作だけを、
 * 呼び出し元の自分の path の範囲に限って行う。今の action は rm のみ（足す時は HANDLERS に 1 つ足す）。
 */

/** 呼び出し元（MCP の header から決まる）。worker は workerId の path、cap は capId の path と自分の worker の path が範囲。 */
export type BashCaller = { kind: "cap"; capId: string } | { kind: "worker"; capId: string; workerId: string };

export interface BashArgs {
  action: string;
  paths: string[];
  recursive?: boolean | undefined;
}

export interface BashResult {
  removed: string[];
  skipped: Array<{ path: string; reason: string }>;
}

/** 1 回に受ける path の件数と、1 path の長さの上限（mcp.ts の zod で使う）。 */
export const MAX_BASH_PATHS = 100;
export const MAX_BASH_PATH_LENGTH = 1024;

// -- /mcp route との橋渡し -------------------------------------------------------

let workspace: string | undefined;

/** daemon が起動後に設定する。未設定の間（起動中・終了中）の bash は拒否する。 */
export function setBashWorkspace(w: string | undefined): void {
  workspace = w;
}

export function getBashWorkspace(): string | undefined {
  return workspace;
}

// -- rm ----------------------------------------------------------------------------

const PROTECTED_MSG = "logs/ と state.json は server の記録なので消せない";
const WORKER_PREFIX = "worker:";

const errCode = (e: unknown): string | undefined => (e as NodeJS.ErrnoException).code;
const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const isMissing = (e: unknown): boolean => errCode(e) === "ENOENT" || errCode(e) === "ENOTDIR";
const isInside = (root: string, p: string): boolean => p === root || p.startsWith(root + sep);
const isProtected = (name: string | undefined): boolean => name !== undefined && KEEP_ENTRIES.includes(name.toLowerCase());

type Rejected = { reason: string };

/**
 * path 1 つを消す。判定の順序:
 *  1. 文字列の検査（NUL・絶対パス・~・drive・バックスラッシュ）
 *  2. 範囲の決定（自分の path / cap なら `worker:<id>/` の worker の path。持ち主を logs/owner.json で確認）
 *  3. 字面の正規化（`.` と空を落とし、`..` は拒否）。何も残らない = path そのもの → 拒否
 *  4. 先頭要素が logs / state.json（大文字小文字を区別しない）なら拒否
 *  5. 親を realpath で解決し、範囲の realpath の中か確認（symlink 経由の脱出を拒否）。解決後の先頭要素も 4 と同じ検査
 *  6. 対象を lstat（symlink は辿らない）。dir は recursive: true の時だけ
 *  7. 削除の直前に lstat と親の realpath を取り直し、5・6 の結果と同じか確認（TOCTOU の窓を狭める）
 *  8. 非 dir は unlink（symlink は link 自体）、dir は rm recursive（node の rm は symlink を辿らない）
 */
async function rmOne(ws: string, caller: BashCaller, raw: string, recursive: boolean): Promise<Rejected | null> {
  if (raw.includes("\0")) return { reason: "NUL 文字は不可" };
  if (raw.startsWith("/")) return { reason: "絶対パスは不可（自分の path からの相対で指定する）" };
  if (raw.startsWith("~")) return { reason: "~ は不可" };
  if (/^[A-Za-z]:/.test(raw)) return { reason: "drive 指定は不可" };
  if (raw.includes("\\")) return { reason: "バックスラッシュは不可" };

  let rootDir: string;
  let rest = raw;
  try {
    if (raw.startsWith(WORKER_PREFIX)) {
      if (caller.kind !== "cap") return { reason: "worker: 接頭辞は cap だけが使える" };
      const slash = raw.indexOf("/");
      const id = raw.slice(WORKER_PREFIX.length, slash < 0 ? undefined : slash);
      rest = slash < 0 ? "" : raw.slice(slash + 1);
      if (!isValidAgentId(id)) return { reason: `worker_id が不正: ${id}` };
      const owner = await readOwner(ws, id);
      if (owner === undefined) return { reason: `worker が存在しない: ${id}` };
      if (owner !== caller.capId) return { reason: `別の cap の worker: ${id}` };
      rootDir = agentDir(ws, "worker", id);
    } else {
      rootDir = caller.kind === "cap" ? agentDir(ws, "cap", caller.capId) : agentDir(ws, "worker", caller.workerId);
    }
  } catch (e) {
    return { reason: errMsg(e) };
  }

  const segs = rest.split("/").filter((s) => s !== "" && s !== ".");
  if (segs.includes("..")) return { reason: ".. は不可" };
  if (segs.length === 0) return { reason: "path の dir そのものは消せない" };
  if (isProtected(segs[0])) return { reason: PROTECTED_MSG };

  let realRoot: string;
  let realParent: string;
  try {
    realRoot = await realpath(rootDir);
    realParent = await realpath(join(rootDir, ...segs.slice(0, -1)));
  } catch (e) {
    return { reason: isMissing(e) ? "存在しない" : errMsg(e) };
  }
  if (!isInside(realRoot, realParent)) return { reason: "範囲外（symlink を辿ると自分の path の外に出る）" };
  const full = join(realParent, segs[segs.length - 1] as string);
  if (isProtected(relative(realRoot, full).split(sep)[0])) return { reason: PROTECTED_MSG };

  let st;
  try {
    st = await lstat(full);
  } catch (e) {
    return { reason: isMissing(e) ? "存在しない" : errMsg(e) };
  }
  const isDir = st.isDirectory();
  if (isDir && !recursive) return { reason: "dir は recursive: true が必要" };

  try {
    const st2 = await lstat(full);
    const parent2 = await realpath(join(rootDir, ...segs.slice(0, -1)));
    if (parent2 !== realParent || st2.ino !== st.ino || st2.dev !== st.dev) return { reason: "検査の後で path が変わったので消さない" };
    if (isDir) await rm(full, { recursive: true, force: false });
    else await unlink(full);
  } catch (e) {
    return { reason: isMissing(e) ? "存在しない" : errMsg(e) };
  }
  return null;
}

async function actionRm(ws: string, caller: BashCaller, args: BashArgs): Promise<BashResult> {
  const out: BashResult = { removed: [], skipped: [] };
  for (const p of args.paths) {
    const rejected = await rmOne(ws, caller, p, args.recursive === true);
    if (rejected === null) out.removed.push(p);
    else out.skipped.push({ path: p, reason: rejected.reason });
  }
  return out;
}

type Handler = (ws: string, caller: BashCaller, args: BashArgs) => Promise<BashResult>;

/** action ごとの handler。action を足す時はここに足す（範囲の判定は action の中で rmOne と同じ流儀で行う）。 */
const HANDLERS: Readonly<Record<string, Handler>> = Object.freeze({ rm: actionRm });

/** action を handler 表で引いて実行する。未知の action は投げる。引数の形（件数・長さ）は呼び出し側の zod が見る。 */
export async function runBash(ws: string, caller: BashCaller, args: BashArgs): Promise<BashResult> {
  const h = Object.hasOwn(HANDLERS, args.action) ? HANDLERS[args.action] : undefined;
  if (!h) throw new Error(`未知の action: ${args.action}（使えるのは ${Object.keys(HANDLERS).join(", ")}）`);
  return h(ws, caller, args);
}
