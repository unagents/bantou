/**
 * worker の起こし方の負荷管理。
 * - 同時に動かす worker は maxParallel 本まで（reply の起こし直しも数える）。
 * - 負荷平均（1 分）が CPU 数を超えている間は、空きが在っても新しく起こさない。
 * - launch は来た順の queue。空きが在ればすぐ起こし、worker が終わるたびに先頭を 1 本起こす。
 * - reply の起こし直しは queue では新しい launch より先（reply 同士は来た順）。同じ session の run が終わっていること。
 * - stop は queue で待っている物も外す。
 */

export const QUEUE_POLL_MS = 5000;

export interface Job {
  kind: "launch" | "reply";
  /** 起こした cap の名前（stop の照合用）。 */
  parentId: string;
  /** claude の session（reply の起こし直しは、同じ session の run が終わってから）。 */
  sessionId: string;
  /** 起こす。返った Promise が終わった時が、その worker の終わり。reject しない。 */
  start(): Promise<void>;
  /** 動いている worker を止める。 */
  abort(): void;
  /** queue で待っているうちに外された（stop）。 */
  cancelled?(): void;
}

export interface QueueOptions {
  maxParallel: number;
  /** CPU 数。負荷の上限（これを超えた 1 分の負荷平均の間は起こさない）。 */
  cpus: () => number;
  /** 1 分の負荷平均。 */
  loadavg1: () => number;
  pollMs?: number;
  log?: (msg: string) => void;
}

export interface WorkQueue {
  submit(job: Job): void;
  /** parent-id の cap が起こした作業を全部止める（動いている物と queue で待っている物）。 */
  stop(parentId: string): { running: number; queued: number };
  /** 今の数。 */
  counts(): { running: number; queued: number };
  /** timer を止める（動いている worker は止めない）。 */
  close(): void;
}

export function createWorkQueue(o: QueueOptions): WorkQueue {
  const log = o.log ?? (() => {});
  const replies: Job[] = [];
  const launches: Job[] = [];
  const running = new Set<Job>();
  let timer: ReturnType<typeof setInterval> | undefined;
  let closed = false;

  const waiting = (): number => replies.length + launches.length;

  /** 同じ session の run が動いている間は、その reply の起こし直しは起こせない。 */
  const sessionRunning = (sessionId: string): boolean => [...running].some((j) => j.sessionId === sessionId);

  /** 起こす物: reply（同じ session の run が終わっている物の先頭）、無ければ launch の先頭。 */
  const next = (): Job | undefined => {
    const i = replies.findIndex((r) => !sessionRunning(r.sessionId));
    return i >= 0 ? replies.splice(i, 1)[0] : launches.shift();
  };

  /** 空きと負荷が許す限り先頭から起こす。 */
  const pump = (): void => {
    while (!closed && waiting() > 0 && running.size < o.maxParallel && o.loadavg1() <= o.cpus()) {
      const job = next();
      if (job === undefined) break;
      running.add(job);
      void job
        .start()
        .catch((e: unknown) => log(`worker の実行で例外: ${e instanceof Error ? e.message : String(e)}`))
        .finally(() => {
          running.delete(job);
          pump();
        });
    }
    // 待っていて動かせない（負荷が高い・満席）間は、再確認の timer を持つ。満席は worker の終了で pump される
    if (!closed && waiting() > 0) {
      if (timer === undefined) {
        timer = setInterval(pump, o.pollMs ?? QUEUE_POLL_MS);
        timer.unref?.();
      }
    } else if (timer !== undefined) {
      clearInterval(timer);
      timer = undefined;
    }
  };

  return {
    submit(job) {
      (job.kind === "reply" ? replies : launches).push(job);
      pump();
    },
    stop(parentId) {
      let queued = 0;
      for (const list of [replies, launches]) {
        for (let i = list.length - 1; i >= 0; i--) {
          const j = list[i] as Job;
          if (j.parentId !== parentId) continue;
          list.splice(i, 1);
          j.cancelled?.();
          queued++;
        }
      }
      let stopped = 0;
      for (const j of running) {
        if (j.parentId !== parentId) continue;
        j.abort();
        stopped++;
      }
      pump();
      return { running: stopped, queued };
    },
    counts: () => ({ running: running.size, queued: waiting() }),
    close() {
      closed = true;
      if (timer !== undefined) clearInterval(timer);
      timer = undefined;
    },
  };
}
