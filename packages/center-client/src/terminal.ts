// Terminal relay to a center session: output stream (SSE) with reconnect, input, resize.
// Mirrors `packages/desktop/src-tauri/src/terminal.rs`. Framework independent: fetch + stream parse
// only. The connection target comes from `selectTarget` (inject `getTarget`); URL and token are
// never rebuilt here. Errors and logs carry neither the token nor the userinfo of a URL.

import { centerUrl, reconnectDelayMs, streamOnce, type SseEvent } from "./events.ts";
import { scrub } from "./mcp.ts";
import { redactUrl } from "./normalize.ts";
import type { Target } from "./settings.ts";

export const OUTPUT_EVENT = "session-output";
export const STATUS_EVENT = "session-output-status";

export const CONNECT_TIMEOUT_MS = 5_000;
export const POST_TIMEOUT_MS = 10_000;
/** Longest response body written to the log. */
export const LOG_BODY_CHARS = 2000;

/** Payload of the event `session-output` (same shape as `SessionOutput` in packages/ui). */
export interface OutputPayload {
  session: string;
  /** Chunk id (0 on a reset: it carries no chunk). */
  id: number;
  /** Base64 of the raw pty bytes (empty on a reset). */
  data: string;
  reset: boolean;
}

/** Payload of the event `session-output-status` (same shape as `SessionOutputStatus` in packages/ui). */
export interface StatusPayload {
  session: string;
  state: "connected" | "retrying" | "rejected";
  message: string | null;
}

export interface Logger {
  info(msg: string): void;
  warn(msg: string): void;
}

/** An error whose message is safe to show (no token, no userinfo). `status`: HTTP status when one was seen. */
export class TerminalError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "TerminalError";
  }
}

// -- text helpers ------------------------------------------------------------------------

/** A response body for the log: cut at `LOG_BODY_CHARS`, newlines folded so it stays one line. */
export function clipBody(body: string): string {
  const t = [...body].slice(0, LOG_BODY_CHARS).join("").split(/\s+/).filter(Boolean).join(" ");
  return t === "" ? "(empty body)" : t;
}

// -- requests ----------------------------------------------------------------------------

/**
 * `<origin of the MCP url>/sessions/<name>/<tail>` (the name is percent-encoded as a path segment; userinfo, query and
 * fragment are dropped). Only http(s) is accepted. (terminal.rs `session_url`)
 */
export function sessionUrl(mcpUrl: string, session: string, tail: string): string {
  try {
    const u = new URL(mcpUrl);
    if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("scheme");
    return centerUrl(mcpUrl, ["sessions", session, tail]).href;
  } catch {
    throw new TerminalError("center の URL が不正");
  }
}

export const inputBody = (dataB64: string): { data: string } => ({ data: dataB64 });
export const resizeBody = (cols: number, rows: number): { cols: number; rows: number } => ({ cols, rows });

// -- checks (the center checks too, `http.ts` input / resize; ours give the same answer early) ----

export const SESSION_NAME = /^[A-Za-z0-9_-]+$/;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

export function checkSessionName(name: unknown): string {
  if (typeof name !== "string" || !SESSION_NAME.test(name)) throw new TerminalError("session 名は英数字と _ - のみ", 400);
  return name;
}

export function checkInputData(data: unknown): string {
  if (typeof data !== "string" || !BASE64.test(data)) throw new TerminalError("data は base64 文字列", 400);
  return data;
}

export function checkSize(cols: unknown, rows: unknown): { cols: number; rows: number } {
  const ok = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 1000;
  if (!ok(cols) || !ok(rows)) throw new TerminalError("cols / rows は 1〜1000 の整数", 400);
  return { cols, rows };
}

// -- SSE payload -------------------------------------------------------------------------

/**
 * Turn an SSE event into the payload to emit and the new last chunk id. `reset` forgets the id (the
 * stream restarts from the center's oldest chunk); other events (and `output` with a broken id)
 * are ignored. (terminal.rs `to_payload`)
 */
export function toPayload(
  session: string,
  ev: SseEvent,
  lastId: number | undefined,
): { payload?: OutputPayload; lastId: number | undefined } {
  if (ev.event === "reset") return { payload: { session, id: 0, data: "", reset: true }, lastId: undefined };
  if (ev.event === "output") {
    const raw = ev.id?.trim();
    if (raw === undefined || !/^\d+$/.test(raw)) return { lastId };
    const id = Number(raw);
    if (!Number.isSafeInteger(id)) return { lastId };
    return { payload: { session, id, data: ev.data, reset: false }, lastId: id };
  }
  return { lastId };
}

function causeText(e: unknown): string {
  const c = (e as { cause?: { code?: unknown; message?: unknown } } | undefined)?.cause;
  if (typeof c?.code === "string") return c.code;
  if (typeof c?.message === "string") return c.message;
  return e instanceof Error ? e.message : String(e);
}

// -- POST (input / resize) ---------------------------------------------------------------

export interface PostOptions {
  fetch?: typeof fetch;
  target: Target;
  session: string;
  tail: "input" | "resize";
  body: unknown;
  log?: Logger;
  timeoutMs?: number;
}

/** POST to `/sessions/<name>/<tail>`; 2xx is success. (terminal.rs `post`) */
export async function postSession(o: PostOptions): Promise<void> {
  const url = sessionUrl(o.target.url, o.session, o.tail);
  const where = redactUrl(url);
  const tok = o.target.token;
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (tok) headers.authorization = `Bearer ${tok}`;
  // What was sent, for the log: the size for `resize`; for `input` only the length (keystrokes stay out).
  const sent =
    o.tail === "resize"
      ? JSON.stringify(o.body)
      : `${typeof (o.body as { data?: unknown }).data === "string" ? (o.body as { data: string }).data.length : 0} bytes (base64)`;
  let resp: Response;
  try {
    resp = await (o.fetch ?? fetch)(url, {
      method: "POST",
      headers,
      body: JSON.stringify(o.body),
      signal: AbortSignal.timeout(o.timeoutMs ?? POST_TIMEOUT_MS),
    });
  } catch (e) {
    const why = scrub(causeText(e), o.target.url, tok);
    o.log?.warn(`terminal ${o.tail} [${o.session}]: cannot reach ${where}: ${why} (sent ${sent})`);
    throw new TerminalError(scrub(`${where} に接続できない: ${why}`, o.target.url, tok));
  }
  if (resp.ok) {
    await resp.arrayBuffer().catch(() => undefined);
    return;
  }
  const text = scrub(await resp.text().catch(() => ""), o.target.url, tok);
  o.log?.warn(`terminal ${o.tail} [${o.session}]: HTTP ${resp.status}: ${clipBody(text)} (sent ${sent})`);
  const reason = resp.status === 409 ? "セッションは動いていない" : [...text].slice(0, 200).join("");
  throw new TerminalError(`center が ${resp.status} を返した: ${reason}`, resp.status);
}

// -- the relay ---------------------------------------------------------------------------

export interface OutputSubscription {
  stop(): void;
}

export interface TerminalsOptions {
  /** Where to connect: `createCenterSettings(...).selectTarget` (token goes only where selectTarget says). */
  getTarget: () => Promise<Target | undefined>;
  fetch?: typeof fetch;
  log?: Logger;
  readTimeoutMs?: number;
  connectTimeoutMs?: number;
  /** Test hook: replaces the reconnect wait. Resolve at once to retry at once. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

export interface OpenOutputOptions {
  /** The last chunk id the consumer holds (sent as `Last-Event-ID`). */
  after?: number;
  onOutput: (p: OutputPayload) => void;
  onStatus?: (s: StatusPayload) => void;
}

const defaultSleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });

/**
 * Handlers keyed like the desktop commands (`session_output_start`, `session_output_stop`,
 * `session_input`, `session_resize`; attachments are in `attachment.ts`). `openOutput` is the
 * unkeyed form a web backend uses per browser connection.
 */
export function createTerminals(opts: TerminalsOptions) {
  const log = opts.log;
  const sleep = opts.sleep ?? defaultSleep;
  const running = new Map<string, OutputSubscription>();

  function openOutput(sessionName: string, o: OpenOutputOptions): OutputSubscription {
    const session = checkSessionName(sessionName);
    const ctrl = new AbortController();
    const status = (state: StatusPayload["state"], message: string | null) => {
      if (state === "connected") log?.info(`terminal output [${session}]: connected`);
      else if (message) log?.warn(`terminal output [${session}]: ${state}: ${message}`);
      else log?.info(`terminal output [${session}]: ${state}`);
      try {
        o.onStatus?.({ session, state, message });
      } catch {
        // a failing sink must not end the stream
      }
    };
    const run = async () => {
      let last = o.after;
      let failures = 0;
      while (!ctrl.signal.aborted) {
        let target: Target | undefined;
        try {
          target = await opts.getTarget();
          if (!target) throw new TerminalError("接続先が無い");
          sessionUrl(target.url, session, "output"); // http(s) only
          let announced = false;
          const end = await streamOnce(
            { url: target.url, token: target.token },
            ["sessions", session, "output"],
            (ev) => {
              if (!announced) {
                announced = true;
                status("connected", null);
              }
              const r = toPayload(session, ev, last);
              last = r.lastId;
              if (r.payload) {
                try {
                  o.onOutput(r.payload);
                } catch {
                  // a failing sink must not end the stream
                }
              }
              return true;
            },
            {
              fetch: opts.fetch,
              ...(last !== undefined ? { lastEventId: last } : {}),
              readTimeoutMs: opts.readTimeoutMs,
              connectTimeoutMs: opts.connectTimeoutMs ?? CONNECT_TIMEOUT_MS,
              signal: ctrl.signal,
            },
          );
          if (ctrl.signal.aborted || end.type === "stopped") return;
          if (end.type === "rejected") {
            log?.warn(`terminal output [${session}]: center rejected the stream: HTTP ${end.status}: ${clipBody(end.body)}`);
            status("rejected", `center が ${end.status} を返した`);
            return;
          }
          if (announced) failures = 0;
          status("retrying", null);
        } catch (e) {
          if (ctrl.signal.aborted) return;
          status("retrying", target ? scrub(e instanceof Error ? e.message : String(e), target.url, target.token) : e instanceof Error ? e.message : String(e));
        }
        await sleep(reconnectDelayMs(failures), ctrl.signal);
        failures = Math.min(failures + 1, 1000);
      }
    };
    void run();
    return { stop: () => ctrl.abort() };
  }

  async function target(): Promise<Target> {
    const t = await opts.getTarget();
    if (!t) throw new TerminalError("接続先が無い");
    return t;
  }

  return {
    openOutput,
    /** Start (or restart) the output stream of `session`. `after`: the last chunk id the consumer holds. */
    outputStart(session: string, after: number | null | undefined, o: Omit<OpenOutputOptions, "after">): void {
      running.get(session)?.stop();
      const sub = openOutput(session, { ...o, ...(after === null || after === undefined ? {} : { after }) });
      running.set(session, sub);
    },
    outputStop(session: string): void {
      running.get(session)?.stop();
      running.delete(session);
    },
    async input(session: string, dataB64: string): Promise<void> {
      checkSessionName(session);
      checkInputData(dataB64);
      await postSession({ fetch: opts.fetch, target: await target(), session, tail: "input", body: inputBody(dataB64), log });
    },
    async resize(session: string, cols: number, rows: number): Promise<void> {
      checkSessionName(session);
      checkSize(cols, rows);
      await postSession({ fetch: opts.fetch, target: await target(), session, tail: "resize", body: resizeBody(cols, rows), log });
    },
    /** Stop every running stream. */
    close(): void {
      for (const s of running.values()) s.stop();
      running.clear();
    },
    getTarget: target,
  };
}

export type Terminals = ReturnType<typeof createTerminals>;
