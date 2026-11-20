import { startSessionWatch, noteAuthFailure } from "./session-watch";

// Web side of the transport seam (see packages/desktop/src/tauri/transport.ts for the shape and the contract).
// A command is `POST /api/rpc/<cmd>` (body: the args object itself; 200 + JSON, or an HTTP status + {"error": string}).
// An event is a named SSE event of `GET /api/events`. Command names, event names and payload types are the same as on
// desktop; nothing here is specific to the web beyond how they are carried. The browser holds no token: the center's
// token stays in the web backend, and Cloudflare Access sits in front of both.

/** Stop listening. */
export type UnlistenFn = () => void;

export interface InvokeOptions {
  headers?: Record<string, string>;
  /** Raw request body (sent instead of `args`): the image bytes of `session_attach_bytes`. */
  body?: Uint8Array;
}

export interface Transport {
  invoke<T>(cmd: string, args?: Record<string, unknown>, opts?: InvokeOptions): Promise<T>;
  listen<T>(event: string, handler: (payload: T) => void): Promise<UnlistenFn>;
}

/** A failed command. `String(e)` is the backend's message alone, like the string a Tauri `invoke` rejects with. */
export class RpcError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "RpcError";
    this.status = status;
  }
  override toString(): string {
    return this.message;
  }
}

export const RPC_PATH = "/api/rpc/";
export const EVENTS_PATH = "/api/events";

/** Events the browser itself produces (desktop gets them from the OS through Rust). */
const OS_WAKE_EVENT = "bantou://os-wake";
const SESSIONS_CHANGED_EVENT = "bantou://sessions-changed";
const OS_NETWORK_EVENT = "bantou://os-network-changed";

/** Image types the attachment route takes (`packages/center-client` sniffs the same four). */
function sniffImageType(b: Uint8Array): string | undefined {
  const at = (off: number, bytes: number[]) => bytes.every((v, i) => b[off + i] === v);
  if (at(0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (at(0, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (at(0, [0x47, 0x49, 0x46, 0x38, 0x37, 0x61]) || at(0, [0x47, 0x49, 0x46, 0x38, 0x39, 0x61])) return "image/gif";
  if (b.length >= 12 && at(0, [0x52, 0x49, 0x46, 0x46]) && at(8, [0x57, 0x45, 0x42, 0x50])) return "image/webp";
  return undefined;
}

const sessionPath = (session: unknown, tail: string) => `/api/sessions/${encodeURIComponent(String(session ?? ""))}/${tail}`;

/**
 * Terminal commands that are not an RPC: each has its own route (design 5.1). Returns undefined for any other command.
 * `session_output_start` / `_stop` are not here (they open and close an EventSource, see `startOutput`).
 */
function terminalRequest(cmd: string, args: Record<string, unknown> | undefined, opts: InvokeOptions | undefined): { path: string; headers: Record<string, string>; body: BodyInit } | undefined {
  switch (cmd) {
    case "session_input":
      return { path: sessionPath(args?.session, "input"), headers: { "content-type": "application/json" }, body: JSON.stringify({ data: args?.dataB64 }) };
    case "session_resize":
      return { path: sessionPath(args?.session, "resize"), headers: { "content-type": "application/json" }, body: JSON.stringify({ cols: args?.cols, rows: args?.rows }) };
    case "session_attach_bytes": {
      const { "x-bantou-session": session, ...rest } = opts?.headers ?? {};
      if (!opts?.body) throw new RpcError(0, "画像の body が無い");
      const type = sniffImageType(opts.body);
      if (!type) throw new RpcError(0, "画像の型が違う（png / jpeg / gif / webp のみ）");
      return { path: sessionPath(session, "attachments"), headers: { ...rest, "content-type": type }, body: opts.body as unknown as BodyInit };
    }
    default:
      return undefined;
  }
}

async function invoke<T>(cmd: string, args?: Record<string, unknown>, opts?: InvokeOptions): Promise<T> {
  if (cmd === "session_output_start") return startOutput(String(args?.session ?? ""), (args?.after as number | null | undefined) ?? null) as T;
  if (cmd === "session_output_stop") return stopOutput(String(args?.session ?? "")) as T;
  const term = terminalRequest(cmd, args, opts);
  if (!term && opts?.body) throw new RpcError(0, `${cmd} は body を送れない`);
  let res: Response;
  try {
    res = await fetch(term ? term.path : RPC_PATH + encodeURIComponent(cmd), {
      method: "POST",
      headers: term ? term.headers : { "content-type": "application/json", ...opts?.headers },
      body: term ? term.body : JSON.stringify(args ?? {}),
      cache: "no-store",
      // An expired Access session answers with a redirect to the login page: keep it visible as an opaque redirect.
      redirect: "manual",
    });
  } catch (e) {
    throw new RpcError(0, `つながらない: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (res.type === "opaqueredirect" || res.status === 401 || res.status === 403) {
    // Not a backend answer: look at the Access session (it reloads the page when it is gone).
    void noteAuthFailure();
  }
  if (res.type === "opaqueredirect") throw new RpcError(0, "ログインが必要");
  const text = await res.text();
  let json: unknown;
  let parsed = true;
  try {
    json = text === "" ? undefined : JSON.parse(text);
  } catch {
    json = undefined;
    parsed = false;
  }
  if (!res.ok) {
    const msg = json && typeof json === "object" && typeof (json as { error?: unknown }).error === "string" ? (json as { error: string }).error : `HTTP ${res.status}`;
    throw new RpcError(res.status, msg);
  }
  if (!parsed) {
    // A 2xx that is not JSON is not our backend's answer (the Access login page can come back as a 200): do not hand it on as a value.
    void noteAuthFailure();
    throw new RpcError(res.status, "応答が JSON でない（ログイン画面かもしれない）");
  }
  return json as T;
}

// -- terminal output: one EventSource per session, re-presented as the desktop's `session-output` /
// `session-output-status` events so `useTerminalStore` runs unchanged. The browser reconnects by itself with `Last-Event-ID`.
const SESSION_OUTPUT_EVENT = "session-output";
const SESSION_OUTPUT_STATUS_EVENT = "session-output-status";
const outputs = new Map<string, EventSource>();

function stopOutput(session: string): void {
  outputs.get(session)?.close();
  outputs.delete(session);
}

function startOutput(session: string, after: number | null): void {
  stopOutput(session);
  const url = sessionPath(session, "output") + (after !== null ? `?after=${after}` : "");
  const es = new EventSource(url);
  outputs.set(session, es);
  const status = (state: "connected" | "retrying" | "rejected", message: string | null) => dispatch(SESSION_OUTPUT_STATUS_EVENT, { session, state, message });
  es.addEventListener("output", (e) => {
    const m = e as MessageEvent<string>;
    if (!/^\d+$/.test(m.lastEventId)) return;
    const id = Number(m.lastEventId);
    if (!Number.isSafeInteger(id)) return;
    dispatch(SESSION_OUTPUT_EVENT, { session, id, data: m.data, reset: false });
  });
  es.addEventListener("reset", () => dispatch(SESSION_OUTPUT_EVENT, { session, id: 0, data: "", reset: true }));
  es.addEventListener("status", (e) => {
    try {
      const p = JSON.parse((e as MessageEvent<string>).data) as { state?: string; message?: string | null };
      if (p.state === "connected" || p.state === "retrying" || p.state === "rejected") status(p.state, p.message ?? null);
    } catch {
      // a frame that is not JSON carries no state
    }
  });
  // A dropped connection is retried by the browser (`retrying`); `open` after that is `connected`. When the browser gave up
  // (a non-200 answer or an expired Access session) the watch checks the session, then we say `rejected`.
  let everOpen = false;
  startSessionWatch(es, () => {
    if (outputs.get(session) !== es) return;
    es.close();
    outputs.delete(session);
    status("rejected", "output stream closed");
  });
  es.addEventListener("open", () => {
    if (everOpen) status("connected", null);
    everOpen = true;
  });
  es.addEventListener("error", () => {
    if (es.readyState !== EventSource.CLOSED) status("retrying", null);
  });
}

// One EventSource for every listener (the backend fans the center's events out to all browsers; one stream per tab is enough).
type Handler = (payload: never) => void;
const listeners = new Map<string, Set<Handler>>();
const sourceListeners = new Map<string, (e: MessageEvent) => void>();
let source: EventSource | null = null;
let browserEventsOn = false;

function dispatch(event: string, payload: unknown) {
  for (const h of listeners.get(event) ?? []) h(payload as never);
}

/** Delay before a stream the browser gave up on is opened again (doubles up to the cap; `open` resets it). */
const REOPEN_MIN_MS = 5_000;
const REOPEN_MAX_MS = 60_000;
let reopenDelay = REOPEN_MIN_MS;
let reopenTimer: ReturnType<typeof setTimeout> | null = null;
let reopened = false;

function ensureSource() {
  if (source || reopenTimer) return;
  const es = new EventSource(EVENTS_PATH);
  source = es;
  es.addEventListener("open", () => {
    reopenDelay = REOPEN_MIN_MS;
    // Nothing is replayed to a new stream: a change the backend saw before this stream was open (the first read of the
    // list races with the stream opening) or while it was down has no event. Tell the listeners to read again: the
    // session list the backend caches, and (after a drop) the center itself.
    dispatch(SESSIONS_CHANGED_EVENT, null);
    if (reopened) dispatch(OS_WAKE_EVENT, null);
    reopened = false;
  });
  startSessionWatch(es, () => {
    if (source !== es) return;
    es.close();
    source = null;
    sourceListeners.clear();
    if (listeners.size === 0) return;
    reopened = true;
    reopenTimer = setTimeout(() => {
      reopenTimer = null;
      ensureSource();
    }, reopenDelay);
    reopenDelay = Math.min(reopenDelay * 2, REOPEN_MAX_MS);
  });
  for (const event of listeners.keys()) attach(event);
}

/** Events this file raises itself (the browser's own, and the per-session terminal streams): not on `GET /api/events`. */
const isLocalEvent = (event: string) =>
  event === OS_WAKE_EVENT || event === OS_NETWORK_EVENT || event === SESSION_OUTPUT_EVENT || event === SESSION_OUTPUT_STATUS_EVENT;

function attach(event: string) {
  if (!source || sourceListeners.has(event) || isLocalEvent(event)) return;
  const fn = (e: MessageEvent) => {
    let payload: unknown = null;
    try {
      payload = JSON.parse(e.data as string);
    } catch {
      // a frame that is not JSON carries no payload
    }
    dispatch(event, payload);
  };
  sourceListeners.set(event, fn);
  source.addEventListener(event, fn as EventListener);
}

function onVisible() {
  if (document.visibilityState === "visible") dispatch(OS_WAKE_EVENT, null);
}
const onPageShow = () => dispatch(OS_WAKE_EVENT, null);
const onOnline = () => dispatch(OS_NETWORK_EVENT, null);

function startBrowserEvents() {
  if (browserEventsOn) return;
  browserEventsOn = true;
  document.addEventListener("visibilitychange", onVisible);
  window.addEventListener("pageshow", onPageShow);
  window.addEventListener("online", onOnline);
}

function stopAll() {
  if (reopenTimer) clearTimeout(reopenTimer);
  reopenTimer = null;
  source?.close();
  source = null;
  sourceListeners.clear();
  if (browserEventsOn) {
    browserEventsOn = false;
    document.removeEventListener("visibilitychange", onVisible);
    window.removeEventListener("pageshow", onPageShow);
    window.removeEventListener("online", onOnline);
  }
}

async function listen<T>(event: string, handler: (payload: T) => void): Promise<UnlistenFn> {
  let set = listeners.get(event);
  if (!set) listeners.set(event, (set = new Set()));
  set.add(handler as Handler);
  startBrowserEvents();
  if (!isLocalEvent(event)) {
    ensureSource();
    attach(event);
  }
  return () => {
    const s = listeners.get(event);
    s?.delete(handler as Handler);
    if (s && s.size === 0) {
      listeners.delete(event);
      const fn = sourceListeners.get(event);
      if (fn) source?.removeEventListener(event, fn as EventListener);
      sourceListeners.delete(event);
    }
    if (listeners.size === 0) stopAll();
  };
}

const httpTransport: Transport = { invoke, listen };

export const getTransport = (): Transport => httpTransport;
