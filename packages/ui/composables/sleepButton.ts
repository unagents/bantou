import type { SessionProgress } from "./sessionStatus";

/** What the sleep button needs of a session row (`SessionGroup`). */
export interface SleepButtonSession {
  name: string;
  sleeping: boolean;
  /** Work in progress (`sessionProgress`): the cap is busy, a subagent / background run is going on, or a remote task is running. */
  progress: SessionProgress | null;
}

export interface SleepButtonState {
  disabled: boolean;
  title: string;
}

/**
 * Whether the sleep button can be pressed. It can not while the session is asleep, or while work is in progress
 * (a session at work is not put to sleep: the agent can not write the handoff then; see docs/design/sleep-resession.md, "作業中は眠らせない").
 * "At work" is the same judgment as the "作業進行中" mark (`sessionProgress`); no new state.
 */
export function sleepButtonState(g: SleepButtonSession): SleepButtonState {
  if (g.sleeping) return { disabled: true, title: "スリープ中（開くと起きる）" };
  if (g.progress) return { disabled: true, title: "作業中はスリープできない（作業が終わると押せる）" };
  return { disabled: false, title: "スリープさせる（claude を止めて空ける。開くと元の会話のまま起きる）" };
}

/** The button's click: a session that can not sleep now is left alone (the handler is not called). */
export function clickSleep(g: SleepButtonSession, sleep: (name: string) => unknown): void {
  if (sleepButtonState(g).disabled) return;
  void sleep(g.name);
}
