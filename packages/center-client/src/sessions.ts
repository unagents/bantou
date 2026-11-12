// The center's session list and its cache. Mirrors `packages/desktop/src-tauri/src/session.rs` (the list part).
//
// bantou keeps no list of its own: only the last list that could be fetched is cached in memory, so it can
// still be shown, flagged `reachable: false`, when the center cannot be asked.
//   - the center answered: its list replaces the cache (`reachable: true`);
//   - the center could not be asked: the cached list is kept, `reachable: false`, the reason is carried.
// One cache for the whole backend (all browsers share it). `rev` counts the changes of the cache.

import type { ContextUsage, Session, SessionList, SessionRemote } from "../../ui/types/index.ts";
import type { CenterMcp } from "./mcp.ts";

export type { Session, SessionList };

/** Same event name as the desktop's `SESSIONS_CHANGED_EVENT`. */
export const SESSIONS_CHANGED_EVENT = "bantou://sessions-changed";

export class SessionParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionParseError";
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const bad = (what: string): never => {
  throw new SessionParseError(`invalid type: ${what}`);
};

/** `Option<String>` with `#[serde(default)]`: missing or null is null, a non-string is an error. */
function optStr(o: Record<string, unknown>, k: string): string | null {
  const v = o[k];
  if (v === undefined || v === null) return null;
  return typeof v === "string" ? v : bad(k);
}

const isUint = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0;

function optUint(o: Record<string, unknown>, k: string): number | null {
  const v = o[k];
  if (v === undefined || v === null) return null;
  return isUint(v) ? v : bad(k);
}

function parseContextUsage(v: unknown): ContextUsage | null {
  if (v === undefined || v === null) return null;
  if (!isObj(v)) return bad("contextUsage");
  if (!isUint(v.usedTokens)) return bad("contextUsage.usedTokens");
  const p = v.percent;
  if (p !== undefined && p !== null && typeof p !== "number") bad("contextUsage.percent");
  return {
    usedTokens: v.usedTokens,
    windowTokens: optUint(v, "windowTokens"),
    percent: typeof p === "number" ? p : null,
    updatedAt: optStr(v, "updatedAt"),
  };
}

function parseIssues(v: unknown, k: string): NonNullable<SessionRemote["unreachable"]> {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) return bad(k);
  return v.map((e) => {
    if (!isObj(e)) return bad(k);
    const server = e.server === undefined ? "" : typeof e.server === "string" ? e.server : bad("server");
    const remoteId = e.remoteId === undefined ? "" : typeof e.remoteId === "string" ? e.remoteId : bad("remoteId");
    return { server, remoteId, lastOkAt: optStr(e, "lastOkAt"), at: optStr(e, "at") } as NonNullable<SessionRemote["unreachable"]>[number];
  });
}

function parseRemote(v: unknown): SessionRemote | null {
  if (v === undefined || v === null) return null;
  if (!isObj(v)) return bad("remote");
  const n = (k: string) => (v[k] === undefined ? 0 : isUint(v[k]) ? (v[k] as number) : bad(k));
  const out: SessionRemote = { running: n("running"), waitingReply: n("waitingReply") };
  // empty lists are not serialized (serde `skip_serializing_if = Vec::is_empty`)
  const un = parseIssues(v.unreachable, "unreachable");
  const lost = parseIssues(v.lost, "lost");
  if (un.length > 0) out.unreachable = un;
  if (lost.length > 0) out.lost = lost;
  return out;
}

/** One entry of the center's `session_list`, read the way serde reads `session.rs::Session`: missing items take defaults, unknown keys are dropped. */
export function parseSession(v: unknown): Session {
  if (!isObj(v)) return bad("session");
  if (typeof v.name !== "string") return bad("name");
  const instr = v.instructions;
  if (instr !== undefined && typeof instr !== "boolean") bad("instructions");
  return {
    name: v.name,
    state: optStr(v, "state") as Session["state"],
    sessionUrl: optStr(v, "sessionUrl"),
    source: optStr(v, "source") as Session["source"],
    lastError: optStr(v, "lastError"),
    path: optStr(v, "path"),
    contextUsage: parseContextUsage(v.contextUsage),
    instructions: instr === true,
    activity: optStr(v, "activity") as Session["activity"],
    activityAt: optStr(v, "activityAt"),
    remote: parseRemote(v.remote),
    auth: optStr(v, "auth") as Session["auth"],
    loginUrl: optStr(v, "loginUrl"),
    loginError: optStr(v, "loginError"),
  };
}

/** The center's `session_list` answer as `Session[]`. Throws `SessionParseError`. */
export function parseSessions(v: unknown): Session[] {
  if (!Array.isArray(v)) return bad("session_list");
  return v.map(parseSession);
}

export const emptySessionList = (): SessionList => ({ sessions: [], reachable: true, reason: null, rev: 0 });

/** What a read gave: the center's list, or why it could not be fetched. */
export type Listing = { ok: Session[] } | { err: string };

/** Next list after a read (`rev` is carried over; the cache bumps it when the content changed). Pure. (`apply_listing`) */
export function applyListing(prev: SessionList, listing: Listing): SessionList {
  if ("ok" in listing) return { sessions: [...listing.ok], reachable: true, reason: null, rev: prev.rev };
  return { sessions: [...prev.sessions], reachable: false, reason: listing.err, rev: prev.rev };
}

/** Same content, `rev` aside. */
const sameContent = (a: SessionList, b: SessionList) =>
  JSON.stringify([a.sessions, a.reachable, a.reason]) === JSON.stringify([b.sessions, b.reachable, b.reason]);

/** The last list fetched, in memory. */
export class SessionCache {
  private list: SessionList = emptySessionList();

  get(): SessionList {
    return structuredClone(this.list);
  }

  /** Store the result of a read; the new list and whether it differs from the old one. */
  apply(listing: Listing): { list: SessionList; changed: boolean } {
    const next = applyListing(this.list, listing);
    const changed = !sameContent(this.list, next);
    if (changed) next.rev += 1;
    this.list = next;
    return { list: structuredClone(next), changed };
  }
}

export interface SessionService {
  /** `list_sessions`: the cached list, without asking the center. */
  get(): SessionList;
  /** `refresh_sessions`: re-read the center's `session_list`; listeners are told when the cache changed. */
  refresh(): Promise<SessionList>;
  /** Called when a read changed the cache (the desktop's `bantou://sessions-changed`). Returns the unsubscribe. */
  onChanged(listener: () => void): () => void;
  readonly cache: SessionCache;
}

export interface SessionServiceOptions {
  mcp: Pick<CenterMcp, "json">;
  logger?: { info(msg: string): void; warn(msg: string): void };
}

export function createSessionService(opts: SessionServiceOptions): SessionService {
  const cache = new SessionCache();
  const listeners = new Set<() => void>();
  const log = opts.logger;

  async function fetchList(): Promise<Listing> {
    try {
      const v = await opts.mcp.json("session_list");
      try {
        return { ok: parseSessions(v) };
      } catch (e) {
        return { err: `session_list の結果を読めない: ${(e as Error).message}` };
      }
    } catch (e) {
      return { err: (e as Error).message };
    }
  }

  return {
    cache,
    get: () => cache.get(),
    onChanged(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async refresh() {
      const listing = await fetchList();
      if ("ok" in listing) log?.info(`session list refresh: ${listing.ok.length} sessions`);
      else log?.warn(`session list refresh failed (cached list kept): ${listing.err}`);
      const { list, changed } = cache.apply(listing);
      if (changed) {
        for (const l of [...listeners]) {
          try {
            l();
          } catch {
            // a listener must not break the read
          }
        }
      }
      return list;
    },
  };
}
