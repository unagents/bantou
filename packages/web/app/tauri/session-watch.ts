// Detects that the Cloudflare Access session is gone (design 5.2). After it expires, a fetch / EventSource gets a
// redirect to the Access login page and looks like a plain failure to the SPA. When the event stream keeps failing
// we ask `GET /api/me`; if that does not come back as our backend's answer, reload: the browser then goes through
// the Access login and returns here.

/** Consecutive EventSource errors before `/api/me` is asked. */
export const SSE_FAILURES_BEFORE_CHECK = 3;
/** A reload is refused when the previous one was this recent (a login that cannot succeed must not loop). */
export const RELOAD_GUARD_MS = 30_000;
const RELOAD_KEY = "bantou-web:access-reload-at";

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
  const now = Date.now();
  const last = Number(sessionStorage.getItem(RELOAD_KEY) ?? "0");
  if (now - last < RELOAD_GUARD_MS) return;
  sessionStorage.setItem(RELOAD_KEY, String(now));
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

let watched: EventSource | null = null;

/** Count the stream's failures; `open` / any message resets the count. */
export function startSessionWatch(es: EventSource): void {
  if (watched === es) return;
  watched = es;
  let failures = 0;
  es.addEventListener("open", () => (failures = 0));
  es.addEventListener("error", () => {
    failures++;
    if (failures >= SSE_FAILURES_BEFORE_CHECK) {
      failures = 0;
      void noteAuthFailure();
    }
  });
}
