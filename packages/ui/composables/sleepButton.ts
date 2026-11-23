/** What the sleep button needs of a session row (`SessionGroup`). */
export interface SleepButtonSession {
  name: string;
  /** Why the session cannot be put to sleep now (`sleepBlock`; null: it can). Includes "asleep" and "at work". */
  sleepBlock: string | null;
}

export interface SleepButtonState {
  disabled: boolean;
  title: string;
}

/**
 * Whether the sleep button can be pressed. It can not whenever the center would refuse (design `sleep-resession.md`, U2 A: asleep,
 * not running, needs-input, at work, remote unfinished / unanswered). The reason is the title. One judgment (`sleepBlock`) for the
 * button and the refusal, so they do not drift apart. No new state.
 */
export function sleepButtonState(g: SleepButtonSession): SleepButtonState {
  if (g.sleepBlock !== null) return { disabled: true, title: g.sleepBlock };
  return { disabled: false, title: "スリープさせる（引継ぎを書かせてから止める。開くと新しい会話で引継ぎを渡す）" };
}

/** The button's click: a session that can not sleep now is left alone (the handler is not called). */
export function clickSleep(g: SleepButtonSession, sleep: (name: string) => unknown): void {
  if (sleepButtonState(g).disabled) return;
  void sleep(g.name);
}
