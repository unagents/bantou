/** 親プロセスの死亡検知の確認間隔。 */
export const PARENT_POLL_MS = 2_000;

/**
 * 親が死んだら onOrphan を 1 回呼ぶ。ppid が起動時の値から変わったら死亡とみなす（orphan は 1 / launchd に付け替わる）。
 * 返す関数で監視を止める。タイマーは unref 済み。
 */
export function watchParent(opts: {
  onOrphan: (reason: string) => void;
  getPpid?: () => number;
  intervalMs?: number;
}): () => void {
  const getPpid = opts.getPpid ?? (() => process.ppid);
  const initial = getPpid();
  const timer = setInterval(() => {
    const now = getPpid();
    if (now === initial) return;
    clearInterval(timer);
    opts.onOrphan(`親プロセス終了を検知 (ppid ${initial} -> ${now})`);
  }, opts.intervalMs ?? PARENT_POLL_MS);
  timer.unref();
  return () => clearInterval(timer);
}
