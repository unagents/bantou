// The one assembly of the center-facing parts: settings, MCP, sessions, events (terminal: work unit 4a, see the note).
// A process builds this once and reuses it (design 5.4: one MCP session and one events subscription for all browsers).
// The route layer (web) only calls `rpc`, `health` and `openEventStream`. No Nuxt / Nitro / Tauri import.

import { PassThrough, type Readable } from "node:stream";
import { homedir } from "node:os";
import { join } from "node:path";
import { MAX_BODY_BYTES } from "./body.ts";
import { createCenterSettings, type CenterSettingsHandle } from "./center-settings.ts";
import { CommandError, createCommands, toCommandError, type CommandTable } from "./commands.ts";
import { createCenterEvents, type CenterEvents } from "./events.ts";
import { createFileSettingsStore } from "./file-store.ts";
import { createCenterMcp, NO_TARGET, type CenterMcp, type McpLogger } from "./mcp.ts";
import { createRedactor, type Redactor } from "./redact.ts";
import { createSessionService, SESSIONS_CHANGED_EVENT, type SessionService } from "./sessions.ts";
import type { SettingsStore } from "./store.ts";
import { allowWebTool } from "./tool-policy.ts";

export interface CenterClientOptions {
  /** Where the settings live. Default: a file at `settingsFile` (env `WEB_SETTINGS_FILE`, else the default path). */
  settingsStore?: SettingsStore;
  settingsFile?: string;
  /** Default `process.env`. Read: `WEB_SETTINGS_FILE`, `CENTER_URL`, `CENTER_TOKEN`. */
  env?: Record<string, string | undefined>;
  fetch?: typeof fetch;
  logger?: McpLogger;
  /** Accept `center_set_settings` (decision 14). Default false. */
  allowSettingsWrite?: boolean;
  /** Timings, for tests. */
  keepAliveMs?: number;
}

/** What `rpc` hands to a route: a status and a JSON body. Failures are `{ error }` (the desktop's rejection is a string). */
export interface RpcReply {
  status: number;
  body: unknown;
}

export interface Health {
  status: "ok" | "no-target" | "unreachable";
  connected: boolean;
  source?: "remote" | "sidecar";
  /** Host (and port) of the destination; no userinfo, path or query. */
  host?: string;
  reason?: string;
}

/** An event for the browsers: the desktop's event name and its payload. */
export interface ClientEvent {
  event: string;
  data: unknown;
}

export interface CenterClient {
  readonly settings: CenterSettingsHandle;
  readonly mcp: CenterMcp;
  readonly sessions: SessionService;
  readonly events: CenterEvents;
  /** Command table (name -> handler). Its keys are the allow-list of `rpc`. */
  readonly commands: CommandTable;
  readonly redactor: Redactor;
  /** `POST /api/rpc/:cmd`: the whole job, to the status and the (cleaned) body. Never throws. */
  rpc(cmd: string, bodyText: string): Promise<RpcReply>;
  health(): Promise<Health>;
  /** Listen to the browsers' events (`center-sessions-changed`, `bantou://sessions-changed`). Starts the center subscription on the first call. */
  subscribe(listener: (e: ClientEvent) => void): () => void;
  /** An SSE byte stream of the events for one browser; `close()` ends it (also on `readable` end). */
  openEventStream(): { readable: Readable; close(): void };
  /** Stop the center subscription. */
  close(): Promise<void>;
  // Work unit 4a adds `terminal` here (built from `settings`, with `redactor`), next to `events`.
}

/** The settings file when `WEB_SETTINGS_FILE` is not set: the backend's state dir. */
export function defaultSettingsFile(env: Record<string, string | undefined>): string {
  const state = env.XDG_STATE_HOME?.trim() || join(homedir(), ".local", "state");
  return join(state, "bantou-web", "settings.json");
}

const KEEP_ALIVE_MS = 15_000;

export function createCenterClient(opts: CenterClientOptions = {}): CenterClient {
  const env = opts.env ?? process.env;
  const file = opts.settingsFile ?? (env.WEB_SETTINGS_FILE?.trim() || defaultSettingsFile(env));
  const store = opts.settingsStore ?? createFileSettingsStore(file);
  // Web: tokens are hidden from `get`, the web tool list applies, `enabled: true` is refused until work unit S.
  const redactor = createRedactor({ selectTarget: () => settings.selectTarget() });
  // every log line (mcp, sessions, events, rpc) is cleaned of the secrets known so far
  const logger: McpLogger | undefined = opts.logger && {
    info: (m) => opts.logger!.info(redactor.textSync(m)),
    warn: (m) => opts.logger!.warn(redactor.textSync(m)),
  };
  const settings = createCenterSettings({ settingsStore: store, redactSecrets: true, env, policy: { allowEnabled: false } });
  const mcp = createCenterMcp({ settings, fetch: opts.fetch, logger, policy: { allowTool: allowWebTool } });
  const sessions = createSessionService({ mcp, logger });
  const events = createCenterEvents({ settings, fetch: opts.fetch, logger });

  const raw = createCommands({
    settings,
    mcp,
    sessions,
    allowSettingsWrite: opts.allowSettingsWrite ?? false,
    noteSecrets: (s) => redactor.note(s),
  });

  // browsers' events: one internal subscription each, fanned out to every listener
  const listeners = new Set<(e: ClientEvent) => void>();
  const emit = (e: ClientEvent) => {
    for (const l of [...listeners]) {
      try {
        l(e);
      } catch {
        // one browser must not break the others
      }
    }
  };
  events.subscribe((c) => emit({ event: "center-sessions-changed", data: { reason: c.reason ?? null, name: c.name ?? null } }));
  sessions.onChanged(() => emit({ event: SESSIONS_CHANGED_EVENT, data: null }));

  const subscribe: CenterClient["subscribe"] = (l) => {
    listeners.add(l);
    events.start();
    return () => listeners.delete(l);
  };

  async function rpc(cmd: string, bodyText: string): Promise<RpcReply> {
    // Own keys only: `constructor`, `__proto__` and the like are not commands.
    if (!Object.hasOwn(raw, cmd)) return { status: 404, body: { error: "unknown command" } };
    if (Buffer.byteLength(bodyText) > MAX_BODY_BYTES) return { status: 413, body: { error: "body が大きすぎる" } };
    let args: Record<string, unknown> = {};
    if (bodyText.trim() !== "") {
      let v: unknown;
      try {
        v = JSON.parse(bodyText);
      } catch {
        return { status: 400, body: { error: "body は JSON で渡す" } };
      }
      if (v === null) v = {};
      if (typeof v !== "object" || Array.isArray(v)) return { status: 400, body: { error: "body は JSON のオブジェクトで渡す" } };
      args = v as Record<string, unknown>;
    }
    try {
      const out = await raw[cmd]!(args);
      // `undefined` (a command with no result) is `null`, like a Tauri command returning `()`.
      return { status: 200, body: await redactor.value(out ?? null) };
    } catch (e) {
      const ce = toCommandError(e);
      logger?.warn(`rpc ${cmd} failed (${ce.status}): ${await redactor.text(ce.message)}`);
      return { status: ce.status, body: { error: await redactor.text(ce.message) } };
    }
  }

  async function health(): Promise<Health> {
    const c = await mcp.connection();
    const out: Health = { status: c.connected ? "ok" : c.url === undefined ? "no-target" : "unreachable", connected: c.connected };
    if (c.source !== undefined) out.source = c.source;
    if (c.url !== undefined) {
      try {
        out.host = new URL(c.url).host;
      } catch {
        // not a URL: no host to show
      }
    }
    if (c.lastError !== undefined) out.reason = await redactor.text(c.lastError);
    else if (c.url === undefined) out.reason = NO_TARGET;
    return out;
  }

  function openEventStream() {
    const out = new PassThrough();
    const frame = (e: ClientEvent) => `event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`;
    // Headers go out with the first bytes: a comment line first.
    out.write(": ok\n\n");
    // The secrets are read from the settings for each event (an event can come before any rpc). One chain keeps the order.
    let chain: Promise<void> = Promise.resolve();
    const unsubscribe = subscribe((e) => {
      chain = chain.then(async () => {
        const text = await redactor.text(frame(e));
        if (!out.destroyed && !out.writableEnded) out.write(text);
      });
    });
    const ka = setInterval(() => out.write(": ka\n\n"), opts.keepAliveMs ?? KEEP_ALIVE_MS);
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      clearInterval(ka);
      unsubscribe();
      out.end();
    };
    out.on("close", close);
    return { readable: out as Readable, close };
  }

  return {
    settings,
    mcp,
    sessions,
    events,
    commands: raw,
    redactor,
    rpc,
    health,
    subscribe,
    openEventStream,
    close: () => events.stop(),
  };
}

export { CommandError };
