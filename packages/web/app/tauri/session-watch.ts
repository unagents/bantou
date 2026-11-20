// Detects that the Cloudflare Access session is gone (design 5.2). After it expires, a fetch / EventSource gets a
// redirect to the Access login page and looks like a plain failure to the SPA. When the event stream keeps failing
// we ask `GET /api/me`; if that does not come back as our backend's answer, reload: the browser then goes through
// the Access login and returns here.

/** Consecutive EventSource errors before `/api/me` is asked. */
export const SSE_FAILURES_BEFORE_CHECK = 3;
/** In one tab, at most this many reloads within `RELOAD_WINDOW_MS`; then stop and say "not allowed" (a 403 that a login cannot fix must not loop). */
export const MAX_RELOADS = 2;
export const RELOAD_WINDOW_MS = 10 * 60_000;
const RELOADS_KEY = "bantou-web:access-reloads";

/** Pure: the reload times kept in the tab's sessionStorage (JSON array of epoch ms) -> reload now (with the new list) or stop. */
export function planReload(stored: string | null, now: number): { reload: boolean; list: number[] } {
  let prev: number[] = [];
  try {
    const v = stored ? (JSON.parse(stored) as unknown) : [];
    if (Array.isArray(v)) prev = v.filter((x): x is number => typeof x === "number" && now - x < RELOAD_WINDOW_MS);
  } catch {
    // a broken value counts as no history
  }
  if (prev.length >= MAX_RELOADS) return { reload: false, list: prev };
  return { reload: true, list: [...prev, now] };
}

const deniedListeners = new Set<() => void>();
let denied = false;
/** True once reloading did not help (the session is refused, not expired). */
export const isAccessDenied = () => denied;
/** Be told when `isAccessDenied()` becomes true. Returns the unsubscribe. */
export function onAccessDenied(fn: () => void): () => void {
  deniedListeners.add(fn);
  return () => deniedListeners.delete(fn);
}

/** The stream (or a command) worked: the session is fine, forget the reload history. */
export function noteSessionOk(): void {
  try {
    sessionStorage.removeItem(RELOADS_KEY);
  } catch {
    // no storage: nothing to forget
  }
}

export type SessionState = "ok" | "gone" | "offline";

/** Ask `/api/me`. "offline": the request did not get an answer at all (no network): not a reason to reload. */
export async function probeSession(fetchFn: typeof fetch = fetch): Promise<SessionState> {
  let res: Response;
  try {
    res = await fetchFn("/api/me", { cache: "no-store", redirect: "manual", headers: { accept: "application/json" } });
  } catch {
    return "offline";
  }
  if (res.type === "opaqueredirect" || !res.ok) return "gone";
  try {
    const body = (await res.json()) as { email?: unknown };
    return typeof body.email === "string" ? "ok" : "gone";
  } catch {
    // a 200 that is not our JSON is the login page
    return "gone";
  }
}

function reload() {
  const plan = planReload(sessionStorage.getItem(RELOADS_KEY), Date.now());
  if (!plan.reload) {
    denied = true;
    for (const fn of deniedListeners) fn();
    return;
  }
  sessionStorage.setItem(RELOADS_KEY, JSON.stringify(plan.list));
  location.reload();
}

let checking: Promise<void> | null = null;

/** Check the session once (one at a time); reload when it is gone. */
export function noteAuthFailure(): Promise<void> {
  checking ??= (async () => {
    if ((await probeSession()) === "gone") reload();
  })().finally(() => {
    checking = null;
  });
  return checking;
}

/**
 * Watch the event stream. Two kinds of failure:
 * - the browser keeps retrying (a dropped connection): count them, ask `/api/me` after `SSE_FAILURES_BEFORE_CHECK`;
 * - the browser gave up (`readyState` CLOSED: a non-200 answer or a redirect, which is what an expired Access session
 *   gives): ask at once, then `onGaveUp` so the owner can open a new stream later (while the session is fine).
 * `open` resets the count.
 */
export function startSessionWatch(es: EventSource, onGaveUp: () => void): void {
  let failures = 0;
  es.addEventListener("open", () => {
    failures = 0;
    noteSessionOk();
  });
  es.addEventListener("error", () => {
    if (es.readyState === EventSource.CLOSED) {
      void noteAuthFailure().finally(onGaveUp);
      return;
    }
    failures++;
    if (failures >= SSE_FAILURES_BEFORE_CHECK) {
      failures = 0;
      void noteAuthFailure();
    }
  });
}
