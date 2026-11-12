// The center's `GET /events` (SSE, same port and token as `/mcp`). Mirrors `center_events.rs` and the SSE parts of
// `terminal.rs` (`SseParser`, `center_url`, `reconnect_delay`, `stream_once`).
//
// A `sessions` event is sent once on connect and whenever a session is created, deleted or restored in the center.
// `createCenterEvents` keeps ONE subscription to the connected center and hands each `sessions` event to every
// listener as `{reason, name}` (the desktop's `center-sessions-changed`); the listener then reads `session_list` again.
// The subscription follows the target: when the settings point elsewhere it reconnects there. A lost connection is
// reopened with a growing delay.

import { redactUrl } from "./normalize.ts";
import { scrub } from "./mcp.ts";
import type { Target } from "./settings.ts";

/** Same event name as the desktop's `CHANGED_EVENT`. */
export const CENTER_SESSIONS_CHANGED_EVENT = "center-sessions-changed";

/** A center without `/events` (404) or a refused token (401) is asked again only rarely. */
export const REJECTED_DELAY_MS = 60_000;
/** The center sends a keep-alive every 15 s; three missed ones mean the connection is dead. */
export const READ_TIMEOUT_MS = 45_000;
/** How often the target is compared with the one the subscription was opened for. */
export const TARGET_POLL_MS = 2_000;
const NO_TARGET_WAIT_MS = 5_000;

// -- SSE parsing --------------------------------------------------------------------------

/** One dispatched SSE event. `event` is `message` when the stream gave no `event:` field. */
export interface SseEvent {
  id: string | undefined;
  event: string;
  data: string;
}

/** Incremental parser for `text/event-stream` (WHATWG rules: `\n`, `\r\n` or `\r` line ends, `:` comment lines, multi-line `data`, a blank line dispatches). */
export class SseParser {
  private buf: number[] = [];
  private id: string | undefined;
  private event: string | undefined;
  private data: string[] = [];
  /** A trailing `\r` was the last byte: a following `\n` belongs to it. */
  private skipLf = false;
  private readonly dec = new TextDecoder("utf-8");

  feed(bytes: Uint8Array): SseEvent[] {
    const out: SseEvent[] = [];
    for (const b of bytes) {
      if (this.skipLf) {
        this.skipLf = false;
        if (b === 0x0a) continue;
      }
      if (b === 0x0a) this.line(out);
      else if (b === 0x0d) {
        this.skipLf = true;
        this.line(out);
      } else this.buf.push(b);
    }
    return out;
  }

  private line(out: SseEvent[]): void {
    const line = this.dec.decode(Uint8Array.from(this.buf));
    this.buf = [];
    if (line === "") {
      // Blank line: dispatch (nothing is dispatched without data, per the spec).
      const event = this.event;
      this.event = undefined;
      if (this.data.length > 0) {
        out.push({ id: this.id, event: event ? event : "message", data: this.data.join("\n") });
      }
      this.data = [];
      return;
    }
    if (line.startsWith(":")) return; // comment / keep-alive
    const i = line.indexOf(":");
    const field = i < 0 ? line : line.slice(0, i);
    let value = i < 0 ? "" : line.slice(i + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "id") {
      if (!value.includes("\0")) this.id = value;
    } else if (field === "event") this.event = value;
    else if (field === "data") this.data.push(value);
  }
}

// -- requests -----------------------------------------------------------------------------

/** `<origin of the MCP url>/<segments...>` (segments are percent-encoded; no userinfo, query or fragment). (`center_url`) */
export function centerUrl(mcpUrl: string, segments: string[]): URL {
  let url: URL;
  try {
    url = new URL(mcpUrl);
  } catch {
    throw new Error("center の URL が不正");
  }
  url.username = "";
  url.password = "";
  url.search = "";
  url.hash = "";
  url.pathname = "/" + segments.map(encodeURIComponent).join("/");
  return url;
}

export const eventsUrl = (mcpUrl: string): URL => centerUrl(mcpUrl, ["events"]);

/** Wait before reconnect attempt `n` (0-based): 1, 2, 4, 8, then 15 s. (`reconnect_delay`) */
export function reconnectDelayMs(n: number): number {
  return Math.min(2 ** Math.min(n, 4), 15) * 1000;
}

/** How one connection ended. */
export type StreamEnd =
  /** The server closed the stream or it went silent: reconnect. */
  | { type: "closed" }
  /** The caller's sink asked to stop. */
  | { type: "stopped" }
  /** The center answered with this status and body (404: no /events, 401: bad token): do not retry blindly. */
  | { type: "rejected"; status: number; body: string };

export interface StreamOptions {
  fetch?: typeof fetch;
  lastEventId?: string | number;
  readTimeoutMs?: number;
  /** Give up when the response headers do not arrive within this time (no limit when unset). */
  connectTimeoutMs?: number;
  /** Aborting ends the stream with `closed`. */
  signal?: AbortSignal;
}

/** What a stream is opened for: the center's MCP URL as configured (it may carry userinfo) and the Bearer token. */
export interface StreamTarget {
  url: string;
  token?: string | undefined;
}

/**
 * Open `<origin of target.url>/<segments>` once and feed events to `onEvent` until it ends.
 * It takes the configured URL (not a built one) so that the URL password and the token are known and removed from every error text. `onEvent` returns false to stop.
 * Throws an `Error` (text without secrets) when the center cannot be reached or the read fails. (`stream_once`)
 */
export async function streamOnce(
  target: StreamTarget,
  segments: string[],
  onEvent: (e: SseEvent) => boolean,
  opts: StreamOptions = {},
): Promise<StreamEnd> {
  const url = centerUrl(target.url, segments);
  const doFetch = opts.fetch ?? fetch;
  const readTimeout = opts.readTimeoutMs ?? READ_TIMEOUT_MS;
  const headers: Record<string, string> = { accept: "text/event-stream" };
  if (target.token !== undefined) headers.authorization = `Bearer ${target.token}`;
  if (opts.lastEventId !== undefined) headers["last-event-id"] = String(opts.lastEventId);
  const clean = (m: string) => scrub(m, target.url, target.token);
  // With a connect timeout the request gets its own controller: the timer is cleared once the headers are in, so it never cuts the body.
  let signal = opts.signal;
  let connectTimer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  const link = new AbortController();
  const onCallerAbort = () => link.abort();
  if (opts.connectTimeoutMs !== undefined) {
    signal = link.signal;
    if (opts.signal?.aborted) link.abort();
    else opts.signal?.addEventListener("abort", onCallerAbort, { once: true });
    connectTimer = setTimeout(() => {
      timedOut = true;
      link.abort();
    }, opts.connectTimeoutMs);
  }
  let resp: Response;
  try {
    resp = await doFetch(url.href, { method: "GET", headers, signal });
  } catch (e) {
    opts.signal?.removeEventListener("abort", onCallerAbort);
    if (opts.signal?.aborted) return { type: "closed" };
    const c = (e as { cause?: { code?: string; message?: string } }).cause;
    const why = timedOut ? "接続がタイムアウト" : (e as Error).message;
    throw new Error(clean(`${redactUrl(url.href)} に接続できない: ${why}${c && !timedOut ? ` (${c.code ?? c.message})` : ""}`));
  } finally {
    clearTimeout(connectTimer);
  }
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    opts.signal?.removeEventListener("abort", onCallerAbort);
    return { type: "rejected", status: resp.status, body: clean(body) };
  }
  if (!resp.body) {
    opts.signal?.removeEventListener("abort", onCallerAbort);
    return { type: "closed" };
  }
  const reader = resp.body.getReader();
  const parser = new SseParser();
  try {
    for (;;) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<"timeout">((r) => {
        timer = setTimeout(() => r("timeout"), readTimeout);
      });
      let chunk: ReadableStreamReadResult<Uint8Array> | "timeout";
      try {
        chunk = await Promise.race([reader.read(), timeout]);
      } catch (e) {
        if (opts.signal?.aborted) return { type: "closed" };
        throw new Error(clean(`読み取りに失敗: ${(e as Error).message}`));
      } finally {
        clearTimeout(timer);
      }
      if (chunk === "timeout" || chunk.done) return { type: "closed" };
      for (const ev of parser.feed(chunk.value)) {
        if (!onEvent(ev)) return { type: "stopped" };
      }
    }
  } finally {
    opts.signal?.removeEventListener("abort", onCallerAbort);
    reader.cancel().catch(() => {});
  }
}

// -- center-sessions-changed --------------------------------------------------------------

/** Payload of `center-sessions-changed`. Both fields are null for the event sent on connect. */
export interface Changed {
  reason: string | null;
  name: string | null;
}

/** The payload to forward for an SSE event, or undefined for events that are not `sessions`. (`to_changed`) */
export function toChanged(ev: SseEvent): Changed | undefined {
  if (ev.event !== "sessions") return undefined;
  let v: unknown = null;
  try {
    v = JSON.parse(ev.data);
  } catch {
    // unreadable data still triggers a re-read
  }
  const field = (k: string): string | null => {
    const x = v !== null && typeof v === "object" ? (v as Record<string, unknown>)[k] : undefined;
    return typeof x === "string" ? x : null;
  };
  return { reason: field("reason"), name: field("name") };
}

/** Wait before the next attempt, given how the last one ended (`Error` = it failed). (`retry_delay`) */
export function retryDelayMs(last: StreamEnd | Error, failures: number, rejectedMs = REJECTED_DELAY_MS): number {
  if (!(last instanceof Error) && last.type === "rejected") return rejectedMs;
  return reconnectDelayMs(failures);
}

export interface CenterEventsOptions {
  /** Where to connect, read often (`CenterSettingsHandle.selectTarget`). */
  settings: { selectTarget(): Promise<Target | undefined> };
  fetch?: typeof fetch;
  logger?: { warn(msg: string): void };
  // Timings; the defaults are the desktop's.
  readTimeoutMs?: number;
  targetPollMs?: number;
  noTargetWaitMs?: number;
  rejectedDelayMs?: number;
  reconnectDelayMs?: (failures: number) => number;
}

export interface CenterEvents {
  /** Listen to `center-sessions-changed`. Returns the unsubscribe. */
  subscribe(listener: (c: Changed) => void): () => void;
  /** Start the single subscription (idempotent). */
  start(): void;
  /** Stop it and wait until it has ended (idempotent). */
  stop(): Promise<void>;
}

const sameTarget = (a: Target | undefined, b: Target | undefined) =>
  a !== undefined && b !== undefined && a.url === b.url && a.token === b.token && a.source === b.source;

export function createCenterEvents(opts: CenterEventsOptions): CenterEvents {
  const listeners = new Set<(c: Changed) => void>();
  const readTimeout = opts.readTimeoutMs ?? READ_TIMEOUT_MS;
  const pollMs = opts.targetPollMs ?? TARGET_POLL_MS;
  const noTargetMs = opts.noTargetWaitMs ?? NO_TARGET_WAIT_MS;
  const backoff = opts.reconnectDelayMs ?? reconnectDelayMs;
  let running: { stop: AbortController; done: Promise<void> } | undefined;

  const current = async (): Promise<Target | undefined> => {
    try {
      return await opts.settings.selectTarget();
    } catch {
      return undefined;
    }
  };

  const emit = (c: Changed) => {
    for (const l of [...listeners]) {
      try {
        l(c);
      } catch {
        // a listener must not break the subscription
      }
    }
  };

  /** Sleep that ends early when `signal` aborts. */
  const sleep = (ms: number, signal: AbortSignal) =>
    new Promise<void>((resolve) => {
      if (signal.aborted) return resolve();
      const t = setTimeout(done, ms);
      function done() {
        clearTimeout(t);
        signal.removeEventListener("abort", done);
        resolve();
      }
      signal.addEventListener("abort", done);
    });

  async function run(stop: AbortSignal): Promise<void> {
    let failures = 0;
    while (!stop.aborted) {
      const target = await current();
      if (!target) {
        await sleep(noTargetMs, stop);
        continue;
      }
      let gotEvents = false;
      let moved = false;
      const conn = new AbortController();
      const onStop = () => conn.abort();
      stop.addEventListener("abort", onStop);
      const watch = setInterval(() => {
        void current().then((now) => {
          if (!sameTarget(now, target) && !conn.signal.aborted) {
            moved = true;
            conn.abort();
          }
        });
      }, pollMs);
      let result: StreamEnd | Error;
      try {
        result = await streamOnce(
          target,
          ["events"],
          (ev) => {
            gotEvents = true;
            const c = toChanged(ev);
            if (c) emit(c);
            return true;
          },
          { fetch: opts.fetch, readTimeoutMs: readTimeout, signal: conn.signal },
        );
      } catch (e) {
        result = e instanceof Error ? e : new Error(String(e));
        opts.logger?.warn(`center events: ${scrub(result.message, target.url, target.token)}`);
      } finally {
        clearInterval(watch);
        stop.removeEventListener("abort", onStop);
      }
      if (stop.aborted) return;
      if (moved) {
        // The target changed: reconnect to the new one at once.
        failures = 0;
        continue;
      }
      if (gotEvents) failures = 0;
      await sleep(
        result instanceof Error || result.type !== "rejected" ? backoff(failures) : (opts.rejectedDelayMs ?? REJECTED_DELAY_MS),
        stop,
      );
      failures = Math.min(failures + 1, 0xffff);
    }
  }

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    start() {
      if (running) return;
      const stop = new AbortController();
      running = { stop, done: run(stop.signal) };
    },
    async stop() {
      const r = running;
      if (!r) return;
      running = undefined;
      r.stop.abort();
      await r.done;
    },
  };
}
