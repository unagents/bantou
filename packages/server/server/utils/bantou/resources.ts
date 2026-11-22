import { statfs } from "node:fs/promises";
import { cpus, freemem, loadavg, totalmem } from "node:os";
import type { ResourceSample } from "@agent-hand/bantou-protocol";

/**
 * host の資源の測定。server は測って掲示するだけで、閾値を持たず、足りるかを判定しない（判断は cap）。
 * 周期の再測定は掲示のためだけ（予約の起動の契機ではない）。
 */

export interface ResourceMonitorDeps {
  /** ディスクの空きを測る dir（server の workspace）。 */
  dir: string;
  /** 今動いている worker の本数。 */
  workers: () => number;
  /** 再測定の周期（ms）。 */
  sampleMs: number;
  log: (msg: string) => void;
  now?: () => number;
  /** 測定の差し替え（テスト用）。 */
  measure?: () => Promise<Omit<ResourceSample, "at" | "workers">>;
}

export interface ResourceMonitor {
  /** 今測って、最新の値にする。 */
  sample(): Promise<ResourceSample>;
  /** 最後に測った値（動いている worker の数だけ今の値）。まだ測っていなければ null。 */
  latest(): ResourceSample | null;
  close(): void;
}

export async function measureHost(dir: string): Promise<Omit<ResourceSample, "at" | "workers">> {
  const [load1, load5, load15] = loadavg();
  let disk_total: number | null = null;
  let disk_free: number | null = null;
  try {
    const s = await statfs(dir);
    disk_total = s.blocks * s.bsize;
    disk_free = s.bavail * s.bsize;
  } catch {
    // 測れない時は null（掲示するだけ）
  }
  return { load1: load1 ?? 0, load5: load5 ?? 0, load15: load15 ?? 0, cpus: cpus().length, mem_total: totalmem(), mem_free: freemem(), disk_total, disk_free };
}

export function createResourceMonitor(deps: ResourceMonitorDeps): ResourceMonitor {
  const now = deps.now ?? Date.now;
  const measure = deps.measure ?? ((): Promise<Omit<ResourceSample, "at" | "workers">> => measureHost(deps.dir));
  let last: ResourceSample | null = null;
  let timer: ReturnType<typeof setInterval> | undefined;

  async function sample(): Promise<ResourceSample> {
    const m = await measure();
    last = { at: new Date(now()).toISOString(), ...m, workers: deps.workers() };
    return last;
  }

  const tick = (): void => {
    sample().catch((e: unknown) => deps.log(`資源の測定に失敗: ${e instanceof Error ? e.message : String(e)}`));
  };
  tick();
  if (deps.sampleMs > 0) {
    timer = setInterval(tick, deps.sampleMs);
    timer.unref();
  }

  return {
    sample,
    latest: () => (last === null ? null : { ...last, workers: deps.workers() }),
    close() {
      if (timer) clearInterval(timer);
      timer = undefined;
    },
  };
}
