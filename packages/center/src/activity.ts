import type { ActivityNotice, AgentActivity } from "@agent-hand/bantou-protocol";

/** 通知がこれを超えて来ない時、stale を立てる（server の通知間隔 5 秒の 6 回分）。 */
export const ACTIVITY_STALE_MS = 30_000;

/** remote ごとの活動情報（remote_list に同梱して返す）。 */
export interface RemoteActivity {
  /** 最後に受けた通知の at（server の時計）。 */
  at: string;
  /** 最後の通知を受けてからの ms（center の時計）。 */
  received_ms_ago: number;
  /** running / stalled の agent がいるのに、ACTIVITY_STALE_MS を超えて通知が来ていない（server・経路が落ちた疑い）。 */
  stale: boolean;
  /** silent_ms は「通知時の値 + 受信からの経過」に補正して返す。 */
  agents: AgentActivity[];
}

export interface ActivityStore {
  apply(n: ActivityNotice): void;
  get(capId: string): RemoteActivity | undefined;
  forget(capId: string): void;
}

interface Held {
  notice: ActivityNotice;
  receivedAt: number;
}

/** 保持はメモリのみ。center が再起動したら、次の通知まで空になる。 */
export function createActivityStore(opts: { now?: () => number } = {}): ActivityStore {
  const now = opts.now ?? Date.now;
  const held = new Map<string, Held>();
  return {
    apply(n) {
      held.set(n.cap_id, { notice: n, receivedAt: now() });
    },
    get(capId) {
      const h = held.get(capId);
      if (!h) return undefined;
      const ago = Math.max(0, now() - h.receivedAt);
      const live = h.notice.agents.some((a) => a.state === "running" || a.state === "stalled");
      return {
        at: h.notice.at,
        received_ms_ago: ago,
        stale: live && ago > ACTIVITY_STALE_MS,
        // 通知時点の silent_ms に受信後の経過を足す（desktop はホスト間の時計ずれを避けてこの値を使う）
        agents: h.notice.agents.map((a) => ({ ...a, silent_ms: a.silent_ms + ago })),
      };
    },
    forget(capId) {
      held.delete(capId);
    },
  };
}
