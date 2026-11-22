import type { Session, SessionActivity } from "../types";

/** What is going on in a session (see `SessionGroup.progress`). */
export interface SessionProgress {
  /** The cap itself is in a turn. */
  cap: boolean;
  subagents: number;
  tasks: number;
  /** Remote-caps (servers) with work left. */
  remote: number;
}

/**
 * The cap's own state of a session row (null: show nothing). Needs a reachable center and a listed session.
 * Priority: needs-input (claude's, or an unanswered worker ask) > remote unreachable > remote lost > claude's own working / idle.
 * Claude's own state needs a connected session; an unanswered worker ask / a remote in trouble is shown whatever the state is.
 * "Work in progress" is another axis (`sessionProgress`): it does not change this state.
 */
export function capActivity(r: Session | undefined, reachable: boolean): SessionActivity | null {
  if (!reachable || !r) return null;
  const a = r.activity === "working" || r.activity === "needs-input" || r.activity === "idle" ? r.activity : null;
  const connected = r.state === "connected";
  if (connected && a === "needs-input") return "needs-input";
  if ((r.remote?.waitingReply ?? 0) > 0) return "needs-input";
  // A server that does not answer / a lost cap: the work left there is not going on.
  if ((r.remote?.unreachable?.length ?? 0) > 0) return "remote-unreachable";
  if ((r.remote?.lost?.length ?? 0) > 0) return "remote-lost";
  if (!connected) return null;
  return a;
}

/**
 * Work is going on in the session (null: none): the cap is busy, a subagent / background run is going on, or a remote task is running.
 * Independent of `capActivity`: an idle cap can have work in progress, and a cap waiting for a reply can too.
 */
export function sessionProgress(r: Session | undefined, reachable: boolean): SessionProgress | null {
  if (!reachable || !r || r.state !== "connected") return null;
  const cap = r.activity === "working";
  const subagents = r.background?.subagents ?? 0;
  const tasks = r.background?.tasks ?? 0;
  // A remote cap in trouble (unreachable / lost) is not going on: do not count it as running.
  const remote = Math.max(0, (r.remote?.running ?? 0) - (r.remote?.unreachable?.length ?? 0) - (r.remote?.lost?.length ?? 0));
  return cap || subagents > 0 || tasks > 0 || remote > 0 ? { cap, subagents, tasks, remote } : null;
}
