import { lstat, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isValidAgentId, type AgentActivity } from "@agent-hand/bantou-protocol";
import { STOP_MSG } from "./agents";
import { KEEP_ENTRIES, agentDir, cleanedFile, removeNonKept, runLogDir } from "./paths";
import { readOwner } from "./workers";

/** 掃除の確認間隔の既定。 */
export const CLEANUP_INTERVAL_MS = 60_000;

export interface WorkerCleanerDeps {
  workspace: string;
  /** 終わってから消すまでの待ち（ms）。0 は掃除しない。 */
  keepMs: number;
  /** 全 agent の activity（tracker.snapshot）。 */
  snapshot: () => AgentActivity[];
  /** manager が worker を invoke 中（待ち含む）か。 */
  isActive: (workerId: string) => boolean;
  /** 掃除した worker を activity から外す（tracker.forget）。 */
  forget: (workerId: string) => void;
  log: (msg: string) => void;
  now?: () => number;
  intervalMs?: number;
}

export interface WorkerCleaner {
  /** worker_start の入口で呼ぶ。掃除の待ち時間を数え直し、掃除中ならその完了を待つ。 */
  begin(workerId: string): Promise<void>;
  /** 1 回確認して、消す時間になった worker を掃除する。掃除した worker_id を返す（テスト・手動用）。 */
  sweep(): Promise<string[]>;
  close(): Promise<void>;
}

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** dir 直下の logs/ と state.json 以外を消す。消した件数を返す。dir が無ければ 0。 */
export async function cleanWorkerDir(dir: string): Promise<number> {
  let st;
  try {
    st = await lstat(dir);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw e;
  }
  if (!st.isDirectory()) throw new Error(`dir が通常の directory でない: ${dir}`);
  // logs/ が symlink だと印の書き込みが dir の外へ出る。通常の directory（または無い）時だけ進む
  try {
    if (!(await lstat(runLogDir(dir))).isDirectory()) throw new Error(`logs が通常の directory でないので掃除しない: ${runLogDir(dir)}`);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  // 印を先に書き、.git を先に消す。途中で失敗しても「印あり・.git 無し」になり、再開で clone し直せる
  await mkdir(runLogDir(dir), { recursive: true });
  await rm(cleanedFile(dir), { force: true }); // 印が symlink でも、先を書かず印そのものを置き換える
  await writeFile(cleanedFile(dir), JSON.stringify({ cleaned_at: new Date().toISOString() }) + "\n");
  return await removeNonKept(dir);
}

const isLive = (s: AgentActivity["state"]): boolean => s === "running" || s === "stalled";

/** 掃除の対象になる終わり方か。done、または worker_stop で止めたもの。 */
const isFinishedForCleanup = (a: AgentActivity): boolean =>
  a.state === "done" || (a.state === "failed" && a.error === STOP_MSG);

export function createWorkerCleaner(deps: WorkerCleanerDeps): WorkerCleaner {
  const { workspace, log } = deps;
  const now = deps.now ?? Date.now;
  /** worker_start を受けた時刻。待ち時間はここからも数え直す。 */
  const touched = new Map<string, number>();
  const cleaning = new Map<string, Promise<void>>();
  /** 直近の掃除失敗（同じ理由はログに 1 回だけ出す。成功か再開で消す）。 */
  const lastFailure = new Map<string, string>();
  /** 持ち主記録が無いと知らせた worker（1 回だけ出す）。 */
  const noOwnerLogged = new Set<string>();
  let timer: NodeJS.Timeout | undefined;
  let closed = false;

  const ms = (iso: string | null): number => {
    const t = iso === null ? NaN : Date.parse(iso);
    return Number.isNaN(t) ? 0 : t;
  };

  /** 掃除したら true。直前に再開の指示が来ていた等で見送ったら false。 */
  async function clean(w: AgentActivity): Promise<boolean> {
    const dir = agentDir(workspace, "worker", w.id);
    try {
      // 持ち主の cap が activity と一致する worker だけ消す
      const owner = await readOwner(workspace, w.id);
      if (owner === undefined) {
        if (!noOwnerLogged.has(w.id)) {
          noOwnerLogged.add(w.id);
          log(`持ち主記録が無いので掃除しない: ${w.id}`);
        }
        return false;
      }
      if (owner !== w.cap_id) return false;
      // 判定から削除までの間に worker_start が来ていたら消さない
      if (touched.has(w.id) && now() - (touched.get(w.id) as number) < deps.keepMs) return false;
      if (deps.isActive(w.id)) return false;
      const removed = await cleanWorkerDir(dir);
      deps.forget(w.id);
      touched.delete(w.id);
      lastFailure.delete(w.id);
      noOwnerLogged.delete(w.id);
      log(`worker 掃除: worker_id=${w.id} cap_id=${w.cap_id} state=${w.state} 削除=${removed}件 残す=${KEEP_ENTRIES.join(",")} dir=${dir}`);
      return true;
    } catch (e) {
      const msg = errMsg(e);
      if (lastFailure.get(w.id) !== msg) {
        lastFailure.set(w.id, msg);
        log(`エラー: worker 掃除: worker_id=${w.id} ${msg}`);
      }
      return false;
    }
  }

  async function sweep(): Promise<string[]> {
    if (deps.keepMs <= 0 || closed) return [];
    // keepMs を過ぎた touched は判定に効かない（base は finished_at 側が支配する）ので落とす
    for (const [id, t] of touched) if (now() - t >= deps.keepMs && !cleaning.has(id)) touched.delete(id);
    const all = deps.snapshot();
    // activity から外れた（forget 済み・消えた）worker の抑制記録は落とす
    const present = new Set(all.filter((a) => a.kind === "worker").map((a) => a.id));
    for (const id of [...lastFailure.keys()]) if (!present.has(id)) lastFailure.delete(id);
    for (const id of [...noOwnerLogged]) if (!present.has(id)) noOwnerLogged.delete(id);
    const caps = new Map(all.filter((a) => a.kind === "cap").map((a) => [a.id, a]));
    const picked: AgentActivity[] = [];
    const jobs = new Map<string, Promise<boolean>>();
    for (const w of all) {
      if (w.kind !== "worker" || !isValidAgentId(w.id) || cleaning.has(w.id)) continue;
      if (!isFinishedForCleanup(w) || deps.isActive(w.id)) continue;
      const cap = caps.get(w.cap_id);
      // cap の turn が続いている間は、worker を再開する指示が来うる
      if (cap !== undefined && isLive(cap.state)) continue;
      const base = Math.max(ms(w.finished_at), cap ? ms(cap.finished_at) : 0, touched.get(w.id) ?? 0);
      if (now() - base < deps.keepMs) continue;
      picked.push(w);
    }
    // 判定から掃除開始までの間に await を挟まない（begin が掃除中を見つけられるように）
    for (const w of picked) {
      const job = clean(w);
      jobs.set(w.id, job);
      cleaning.set(w.id, job.then(() => undefined).finally(() => cleaning.delete(w.id)));
    }
    const done: string[] = [];
    for (const w of picked) if (await jobs.get(w.id)) done.push(w.id);
    return done;
  }

  if (deps.keepMs > 0) {
    timer = setInterval(() => void sweep(), deps.intervalMs ?? CLEANUP_INTERVAL_MS);
    timer.unref();
  }

  return {
    async begin(workerId) {
      touched.set(workerId, now());
      lastFailure.delete(workerId);
      const p = cleaning.get(workerId);
      if (p) await p;
    },
    sweep,
    async close() {
      closed = true;
      if (timer) clearInterval(timer);
      await Promise.allSettled([...cleaning.values()]);
    },
  };
}
