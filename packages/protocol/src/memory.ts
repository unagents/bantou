/**
 * External memory (write side): shared by bantou-center and bantou-server. Design: docs/design/external-memory.md.
 *
 * Dependency free on purpose (no MCP SDK): the transport is injected. Both sides create the Streamable HTTP client
 * from their own @modelcontextprotocol/sdk and pass the classes to `createMcpEventSink`.
 * Nothing here logs or returns a token.
 */
import { createHash } from "node:crypto";

/** `memory` field of the `task` command (protocol 1.9.0). Names the memory the server writes the cap's events to. */
export interface TaskMemory {
  /** http / https URL of the memory MCP endpoint. */
  url: string;
  /** Sent as `Authorization: Bearer`. Never logged. Absent = no Authorization header. */
  token?: string;
  /** X-Agent-Id the server uses for the cap's events. The center sets the cap_id here. Absent = the cap_id. */
  agent_id?: string;
  /** Session (master-cap) that gave the task: the counterpart of the cap in its events. */
  session?: string;
}

/** Protocol version from which the `task` command carries `memory`. */
export const MEMORY_MIN_PROTOCOL = "1.9.0";

/** Does a server that declares protocol `version` read `memory` of `task`? Unknown / malformed version = false. */
export function supportsMemory(version: string | undefined): boolean {
  if (typeof version !== "string") return false;
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  const min = /^(\d+)\.(\d+)\.(\d+)/.exec(MEMORY_MIN_PROTOCOL);
  if (!m || !min) return false;
  for (let i = 1; i <= 3; i++) {
    const d = Number(m[i]) - Number(min[i]);
    if (d !== 0) return d > 0;
  }
  return true;
}

const AGENT_PATTERN = /^[A-Za-z0-9_-]+$/;

/**
 * Read a `memory` field leniently: a broken value is dropped (undefined), never an error, so a malformed memory
 * never stops a task. Only http / https URLs without userinfo; token is a single-line printable string.
 */
export function readTaskMemory(v: unknown): TaskMemory | undefined {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return undefined;
  const o = v as Record<string, unknown>;
  if (typeof o.url !== "string" || o.url.length === 0 || o.url.length > 2048) return undefined;
  try {
    const u = new URL(o.url);
    if ((u.protocol !== "http:" && u.protocol !== "https:") || u.username !== "" || u.password !== "") return undefined;
  } catch {
    return undefined;
  }
  const token = typeof o.token === "string" && o.token.length > 0 && o.token.length <= 4096 && /^[\x21-\x7e]+$/.test(o.token) ? o.token : undefined;
  const agent = typeof o.agent_id === "string" && o.agent_id.length <= 64 && AGENT_PATTERN.test(o.agent_id) ? o.agent_id : undefined;
  const session = typeof o.session === "string" && o.session.length <= 128 && AGENT_PATTERN.test(o.session) ? o.session : undefined;
  return { url: o.url, ...(token ? { token } : {}), ...(agent ? { agent_id: agent } : {}), ...(session ? { session } : {}) };
}

// -- event ---------------------------------------------------------------------------------------------------------

export type MemoryEventKind = "user_prompt" | "assistant_message" | "task" | "result" | "report" | "reply";

export interface MemoryParty {
  session?: string;
  capId?: string;
  workerId?: string;
}

/** Arguments of memory's `event` tool (packages/memory/README.md). */
export interface MemoryEvent {
  eventId: string;
  sender: MemoryParty;
  recipient?: MemoryParty;
  remoteId?: string;
  taskId?: string;
  kind: MemoryEventKind;
  body: string;
  /** ISO 8601. */
  at: string;
}

/** Where to send: the memory endpoint and the identity (X-Agent-Id) the events belong to. */
export interface MemoryTarget {
  url: string;
  token?: string;
  agentId: string;
}

export const MEMORY_BODY_MAX = 65536;
export const MEMORY_TRUNCATED_MARK = "\n…[truncated]";
const EVENT_ID_MAX = 128;

/** Remove NUL and cut to MEMORY_BODY_MAX UTF-16 units (mark at the end when cut; no split surrogate pair). Empty after trim = undefined. */
export function sanitizeBody(raw: string): string | undefined {
  const s = raw.replace(/\u0000/g, "");
  if (s.trim().length === 0) return undefined;
  if (s.length <= MEMORY_BODY_MAX) return s;
  let cut = MEMORY_BODY_MAX - MEMORY_TRUNCATED_MARK.length;
  const code = s.charCodeAt(cut - 1);
  if (code >= 0xd800 && code <= 0xdbff) cut -= 1;
  return s.slice(0, cut) + MEMORY_TRUNCATED_MARK;
}

/** Short stable digest of a text (event ids tell apart two different messages sent in the same millisecond). */
export const digest8 = (s: string): string => createHash("sha256").update(s).digest("hex").slice(0, 8);

const clean = (s: string): string => s.replace(/[^A-Za-z0-9_.-]/g, "_");

/**
 * Event id: `<ns>:<part>:<part>...` (ns = "c1" center / "s1" server: the two sides never share an id space).
 * Same parts = same id (a resend dedupes in memory); a different message gets different parts. Over 128 chars
 * (a long session name) the tail is replaced by a digest of the whole.
 */
export function makeEventId(ns: string, ...parts: Array<string | number>): string {
  const id = [ns, ...parts.map((p) => clean(String(p)))].join(":");
  if (id.length <= EVENT_ID_MAX) return id;
  const h = createHash("sha256").update(id).digest("hex").slice(0, 32);
  return `${id.slice(0, EVENT_ID_MAX - 33)}:${h}`;
}

/** `at` for an event: a valid ISO time not later than now + 1 day, else `now`. */
export function eventAt(candidate: string | number | undefined, now: number = Date.now()): string {
  const ms = typeof candidate === "number" ? candidate : typeof candidate === "string" ? Date.parse(candidate) : NaN;
  if (Number.isFinite(ms) && ms <= now + 23 * 3600_000 && ms > 0) return new Date(ms).toISOString();
  return new Date(now).toISOString();
}

/** Build an event with a sanitized body. undefined when the body is empty (memory refuses an empty body). */
export function buildEvent(e: Omit<MemoryEvent, "body"> & { body: string }): MemoryEvent | undefined {
  const body = sanitizeBody(e.body);
  if (body === undefined) return undefined;
  return { ...e, body };
}

// -- body text (shared so center and server write the same words) --------------------------------------------------

/** Body of a `task` event: the goal, then repo / branch / constraints when given. */
export function formatTaskBody(t: { goal: string; repo?: string; branch?: string; constraints?: string[] }): string {
  const lines = [t.goal];
  if (t.repo) lines.push(`repo: ${t.repo}`);
  if (t.branch) lines.push(`branch: ${t.branch}`);
  if (t.constraints && t.constraints.length > 0) lines.push("constraints:", ...t.constraints.map((c) => `- ${c}`));
  return lines.join("\n");
}

/** Body of a `result` event for a task_result. */
export function formatTaskResultBody(r: { state: string; summary: string; error?: string; remaining: string[] }): string {
  const lines = [`[${r.state}] ${r.summary}`];
  if (r.error) lines.push(`error: ${r.error}`);
  if (r.remaining.length > 0) lines.push("remaining:", ...r.remaining.map((x) => `- ${x}`));
  return lines.join("\n");
}

/** Body of a `result` event for a cap_result. */
export function formatCapResultBody(r: { ok: boolean; result_text: string; error?: string }): string {
  return r.ok ? r.result_text : `[failed] ${r.error ?? ""}\n${r.result_text}`;
}

/** Body of a `report` event. */
export const formatReportBody = (kind: string, text: string): string => `(${kind}) ${text}`;

// -- queue ---------------------------------------------------------------------------------------------------------

/** A failure that retrying never fixes (memory answered but refused the event): the item is dropped. */
export class PermanentMemoryError extends Error {}

export interface MemorySink {
  /** Resolve when memory recorded the event or reported it as a duplicate. Throw to retry later; throw PermanentMemoryError to drop. */
  send(target: MemoryTarget, event: MemoryEvent): Promise<void>;
  close?(): Promise<void>;
}

export const MEMORY_QUEUE_MAX = 1000;
export const MEMORY_BACKOFF_BASE_MS = 1000;
export const MEMORY_BACKOFF_MAX_MS = 60_000;

/** Reason text safe for a log line: token removed, single line, short. */
export function redactReason(e: unknown, token?: string): string {
  let s = e instanceof Error ? e.message : String(e);
  if (token) s = s.split(token).join("***");
  s = s.replace(/(Bearer\s+)\S+/gi, "$1***").replace(/\s+/g, " ").trim();
  return s.length > 200 ? `${s.slice(0, 200)}…` : s;
}

export interface MemoryQueue {
  /** Queue an event. Never throws, never waits for the network. Dropped silently when disabled. */
  enqueue(owner: string, target: MemoryTarget, event: MemoryEvent): void;
  /** Resolve when every queue is empty (tests / shutdown). `timeoutMs` bounds the wait. */
  drain(timeoutMs?: number): Promise<boolean>;
  /** Stop retrying and drop the rest. */
  close(): void;
  /** Items waiting, all queues. */
  size(): number;
}

interface Item {
  target: MemoryTarget;
  event: MemoryEvent;
}

interface Lane {
  items: Item[];
  running: boolean;
  failures: number;
  /** Item being sent now (never dropped by the size cap; removed by identity when done). */
  sending?: Item;
  timer?: ReturnType<typeof setTimeout>;
  wake?: () => void;
}

export interface MemoryQueueOptions {
  sink: MemorySink;
  /** Log line (eventId and reason only; no body, no token, no URL). */
  log: (line: string) => void;
  /** Per lane cap. Over it the oldest items are dropped with a log. Default MEMORY_QUEUE_MAX. */
  max?: number;
  baseMs?: number;
  maxMs?: number;
  /** Prefix of log lines, e.g. "memory". */
  label?: string;
}

/**
 * Per (owner, memory endpoint, agent) FIFO. Order is kept; one send at a time; a failed head is retried with exponential
 * backoff (base, 2x ... max) without blocking anything outside its lane. Nothing the queue does can throw into the caller.
 */
export function createMemoryQueue(opts: MemoryQueueOptions): MemoryQueue {
  const max = opts.max ?? MEMORY_QUEUE_MAX;
  const baseMs = opts.baseMs ?? MEMORY_BACKOFF_BASE_MS;
  const maxMs = opts.maxMs ?? MEMORY_BACKOFF_MAX_MS;
  const label = opts.label ?? "memory";
  const lanes = new Map<string, Lane>();
  const idle = new Set<() => void>();
  let closed = false;

  const safeLog = (line: string): void => {
    try {
      opts.log(line);
    } catch {
      // logging never breaks the queue
    }
  };
  const notifyIdle = (): void => {
    if (queued() === 0) for (const f of [...idle]) f();
  };
  const queued = (): number => {
    let n = 0;
    for (const l of lanes.values()) n += l.items.length;
    return n;
  };

  const delay = (lane: Lane, ms: number): Promise<void> =>
    new Promise((resolve) => {
      lane.wake = resolve;
      lane.timer = setTimeout(resolve, ms);
      lane.timer.unref?.();
    });

  async function run(key: string, lane: Lane): Promise<void> {
    lane.running = true;
    try {
      while (!closed && lane.items.length > 0) {
        const head = lane.items[0]!;
        lane.sending = head;
        const remove = (): void => {
          const i = lane.items.indexOf(head);
          if (i >= 0) lane.items.splice(i, 1);
        };
        try {
          await opts.sink.send(head.target, head.event);
          remove();
          lane.failures = 0;
        } catch (e) {
          const reason = redactReason(e, head.target.token);
          if (e instanceof PermanentMemoryError) {
            remove();
            lane.failures = 0;
            safeLog(`${label}: event を捨てた（memory が拒否）: eventId=${head.event.eventId} ${reason}`);
            continue;
          }
          lane.failures += 1;
          const wait = Math.min(maxMs, baseMs * 2 ** (lane.failures - 1));
          safeLog(`${label}: event を送れない（${wait}ms 後に再試行）: eventId=${head.event.eventId} 失敗=${lane.failures} ${reason}`);
          await delay(lane, wait);
        }
      }
    } finally {
      lane.running = false;
      lane.sending = undefined;
      lane.timer = undefined;
      lane.wake = undefined;
      if (lane.items.length === 0) lanes.delete(key);
      notifyIdle();
    }
  }

  return {
    enqueue(owner, target, event) {
      if (closed) return;
      try {
        const key = `${owner}\u0000${target.url}\u0000${target.agentId}`;
        let lane = lanes.get(key);
        if (!lane) {
          lane = { items: [], running: false, failures: 0 };
          lanes.set(key, lane);
        }
        lane.items.push({ target, event });
        while (lane.items.length > max) {
          const at = lane.sending !== undefined && lane.items[0] === lane.sending ? 1 : 0;
          const dropped = lane.items.splice(at, 1)[0]!;
          safeLog(`${label}: event を捨てた（キューが ${max} 件を超えた、古い分から）: eventId=${dropped.event.eventId}`);
        }
        if (!lane.running) void run(key, lane);
      } catch (e) {
        safeLog(`${label}: enqueue に失敗: ${redactReason(e, target.token)}`);
      }
    },
    drain(timeoutMs) {
      if (queued() === 0) return Promise.resolve(true);
      return new Promise((resolve) => {
        let t: ReturnType<typeof setTimeout> | undefined;
        const done = (): void => {
          idle.delete(done);
          if (t) clearTimeout(t);
          resolve(queued() === 0);
        };
        idle.add(done);
        if (timeoutMs !== undefined) t = setTimeout(done, timeoutMs);
      });
    },
    close() {
      closed = true;
      for (const l of lanes.values()) {
        if (l.timer) clearTimeout(l.timer);
        l.wake?.();
        l.items.length = 0;
      }
      lanes.clear();
      for (const f of [...idle]) f();
      void opts.sink.close?.();
    },
    size: queued,
  };
}

// -- MCP sink ------------------------------------------------------------------------------------------------------

/** The part of an MCP client this module uses (structural, so the protocol package needs no SDK). */
export interface McpClientLike {
  connect(transport: unknown): Promise<void>;
  callTool(params: { name: string; arguments: Record<string, unknown> }, resultSchema?: undefined, options?: { timeout?: number }): Promise<unknown>;
  close(): Promise<void>;
}

export interface McpSdkLike {
  Client: new (info: { name: string; version: string }) => McpClientLike;
  StreamableHTTPClientTransport: new (url: URL, opts: { requestInit: { headers: Record<string, string> } }) => unknown;
}

export const MEMORY_CALL_TIMEOUT_MS = 15_000;

/**
 * MemorySink over MCP Streamable HTTP. One client per (url, token, agentId); a failed client is closed and rebuilt on the
 * next attempt. `isError` from the tool = PermanentMemoryError (validation refused); anything thrown is retryable.
 */
export function createMcpEventSink(sdk: McpSdkLike, opts: { clientName: string; clientVersion?: string; timeoutMs?: number }): MemorySink {
  const clients = new Map<string, Promise<McpClientLike>>();
  const timeout = opts.timeoutMs ?? MEMORY_CALL_TIMEOUT_MS;
  const keyOf = (t: MemoryTarget): string => `${t.url}\u0000${t.token ?? ""}\u0000${t.agentId}`;

  const connect = (t: MemoryTarget): Promise<McpClientLike> => {
    const key = keyOf(t);
    let p = clients.get(key);
    if (!p) {
      p = (async () => {
        const client = new sdk.Client({ name: opts.clientName, version: opts.clientVersion ?? "1" });
        const headers: Record<string, string> = { "X-Agent-Id": t.agentId };
        if (t.token) headers.Authorization = `Bearer ${t.token}`;
        await client.connect(new sdk.StreamableHTTPClientTransport(new URL(t.url), { requestInit: { headers } }));
        return client;
      })();
      clients.set(key, p);
      p.catch(() => clients.delete(key));
    }
    return p;
  };

  const drop = (t: MemoryTarget): void => {
    const key = keyOf(t);
    const p = clients.get(key);
    clients.delete(key);
    void p?.then((c) => c.close()).catch(() => {});
  };

  return {
    async send(target, event) {
      let client: McpClientLike;
      try {
        client = await connect(target);
      } catch (e) {
        drop(target);
        throw e;
      }
      let res: unknown;
      try {
        res = await client.callTool({ name: "event", arguments: { ...event } }, undefined, { timeout });
      } catch (e) {
        drop(target);
        throw e;
      }
      const r = res as { isError?: boolean; content?: Array<{ type?: string; text?: string }> } | undefined;
      if (r?.isError === true) {
        const text = r.content?.find((c) => c.type === "text")?.text ?? "event tool error";
        throw new PermanentMemoryError(text);
      }
    },
    async close() {
      const all = [...clients.values()];
      clients.clear();
      await Promise.allSettled(all.map((p) => p.then((c) => c.close())));
    },
  };
}
