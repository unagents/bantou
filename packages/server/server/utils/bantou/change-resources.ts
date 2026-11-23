import type { ResourceSample } from "@agent-hand/bantou-protocol";

/**
 * worker を起こしてよいかの判定（設計書 3.6、M3）。判定に使う値は config の設定値で、既定は「上限なし」（値を足さない）。
 * - maxParallelWorkers: 並行して動かす worker の数の上限。
 * - minFreeMemoryBytes: メモリの空きの下限。測定値がこれを下回る間は起こさない。
 * 質問待ち（waiting_reply）の worker は process が無いので、running に数えない（呼ぶ側が動いている数だけを渡す）。
 */
export interface AdmissionLimits {
  maxParallelWorkers?: number;
  minFreeMemoryBytes?: number;
}

export interface Admission {
  /** 今 running 本動いている時に、もう 1 本起こしてよいか。 */
  canStart(running: number): boolean;
  /** 起こせない理由（掲示用）。起こせるなら undefined。 */
  blockedReason(running: number): string | undefined;
}

export function createAdmission(limits: AdmissionLimits, latest: () => ResourceSample | null): Admission {
  const blockedReason = (running: number): string | undefined => {
    if (limits.maxParallelWorkers !== undefined && running >= limits.maxParallelWorkers) {
      return `並行の上限（${limits.maxParallelWorkers}）に達している`;
    }
    if (limits.minFreeMemoryBytes !== undefined) {
      const s = latest();
      // 測れていない時は下回りとは言えない（測定値が下回る時だけ起こさない）
      if (s !== null && s.mem_free < limits.minFreeMemoryBytes) {
        return `メモリの空き（${s.mem_free} bytes）が下限（${limits.minFreeMemoryBytes} bytes）を下回っている`;
      }
    }
    return undefined;
  };
  return { canStart: (running) => blockedReason(running) === undefined, blockedReason };
}
