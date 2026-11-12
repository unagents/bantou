// MCP client to the center (Streamable HTTP at `/mcp`). Mirrors `packages/desktop/src-tauri/src/center_mcp.rs`.
// JSON-RPC is built by hand (`initialize`, `ping`, `tools/call`) on top of `fetch`; no MCP SDK.
// One session is kept. It is bound to its URL and token. When the center answers 404 to our session id
// we initialize again once and retry. No Nuxt / Nitro / Tauri / browser API here.
//
// Secrets: error text and log lines never carry the token or the userinfo of the URL (`redactUrl`, `scrub`).

import { redactUrl } from "./normalize.ts";
import type { SettingsPolicy, Target } from "./settings.ts";

export const PROTOCOL_VERSION = "2025-06-18";
export const SESSION_HEADER = "mcp-session-id";
/** `initialize` / `ping` / the initialized notification. */
export const SHORT_TIMEOUT_MS = 10_000;
/** `tools/call`: `cap_kick` / `worker_resume` wait for the agent's result, which can take minutes. */
export const CALL_TIMEOUT_MS = 600_000;
export const NO_TARGET = "接続先が無い（center を有効にするか、別ホストの接続設定を貼る）";
const LOG_BODY_CHARS = 2000;

/** MCP `tools/call` result as returned by `center_call`. */
export interface McpToolResult {
  content: { type: string; text?: string }[];
  isError?: boolean;
  [k: string]: unknown;
}

export interface McpLogger {
  info(msg: string): void;
  warn(msg: string): void;
}
const NO_LOG: McpLogger = { info() {}, warn() {} };

/** A failure phrased for the user. */
export class CenterMcpError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CenterMcpError";
  }
}

/** The tool is not in `policy.allowTool`. Nothing was sent to the center. */
export class ToolNotAllowedError extends Error {
  constructor(readonly tool: string) {
    super(`${tool} は許可されていない`);
    this.name = "ToolNotAllowedError";
  }
}

/** The center no longer knows our session id (HTTP 404 on a session request). */
class SessionGone extends Error {
  constructor() {
    super("MCP session が切れた");
  }
}

interface McpSession {
  url: string;
  token: string | undefined;
  /** undefined when the server is stateless (no `mcp-session-id` header issued). */
  id: string | undefined;
  protocol: string;
}

interface Reply {
  status: number;
  contentType: string;
  sessionId: string | undefined;
  body: string;
}

export interface McpClientOptions {
  fetch?: typeof fetch;
  /** `policy.allowTool`: when set, `callTool` refuses other names. Unset: every tool is allowed (desktop). */
  policy?: Pick<SettingsPolicy, "allowTool">;
  logger?: McpLogger;
  clientName?: string;
  clientVersion?: string;
  shortTimeoutMs?: number;
  callTimeoutMs?: number;
}

/** JSON-RPC messages carried by a response body: a JSON value (object or batch) or an SSE stream. (`parse_messages`) */
export function parseMessages(contentType: string, body: string): unknown[] {
  if (contentType.includes("text/event-stream")) {
    const out: unknown[] = [];
    let data: string[] = [];
    const flush = () => {
      if (data.length > 0) {
        try {
          out.push(JSON.parse(data.join("\n")));
        } catch {
          // an unreadable event is skipped
        }
        data = [];
      }
    };
    for (const line of body.split(/\r\n|\n/)) {
      if (line === "") flush();
      else if (line.startsWith("data:")) {
        const rest = line.slice(5);
        data.push(rest.startsWith(" ") ? rest.slice(1) : rest);
      }
    }
    flush();
    return out;
  }
  try {
    const v: unknown = JSON.parse(body);
    return Array.isArray(v) ? v : [v];
  } catch {
    return [];
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

/** The `result` of the response with `id`, or its JSON-RPC error as a `CenterMcpError`. (`pick_response`) */
export function pickResponse(messages: unknown[], id: number): unknown {
  const m = messages.find((x) => isObj(x) && x.id === id && ("result" in x || "error" in x)) as Record<string, unknown> | undefined;
  if (!m) throw new CenterMcpError("応答に該当する JSON-RPC response が無い");
  if ("error" in m) {
    const e = isObj(m.error) ? m.error : {};
    const code = typeof e.code === "number" && Number.isInteger(e.code) ? e.code : 0;
    const msg = typeof e.message === "string" ? e.message : "(no message)";
    throw new CenterMcpError(`MCP error ${code}: ${msg}`);
  }
  return m.result;
}

/** Text of a tool result's `content` blocks, joined by `sep`. */
export function toolText(result: unknown, sep = "\n"): string {
  if (!isObj(result) || !Array.isArray(result.content)) return "";
  return result.content
    .filter((c): c is { text: string } => isObj(c) && typeof c.text === "string")
    .map((c) => c.text)
    .join(sep);
}

/** A response body for the log: cut at 2000 chars, whitespace folded to one line. (`clip_body`) */
export function clipBody(body: string): string {
  const t = [...body].slice(0, LOG_BODY_CHARS).join("").split(/\s+/).filter(Boolean).join(" ");
  return t === "" ? "(empty body)" : t;
}

/** First 200 chars of a body for an error message. (`snippet`) */
function snippet(body: string): string {
  const t = [...body].slice(0, 200).join("");
  return t === "" ? "(empty body)" : t;
}

function unauthorized(url: string, token: string | undefined): string {
  const u = redactUrl(url);
  return token !== undefined
    ? `${u} が token を受け付けない (HTTP 401)。token が違う可能性がある`
    : `${u} は token が必要 (HTTP 401)。接続設定に Authorization が無い`;
}

/** `fetch` refuses a URL with userinfo; the credentials of the URL are never sent (only the Bearer token). */
export function fetchableUrl(url: string): string {
  try {
    const u = new URL(url);
    u.username = "";
    u.password = "";
    return u.href;
  } catch {
    return url;
  }
}

/** Remove the token and the URL password from free text (an error text from a library, a response body). */
export function scrub(text: string, url: string, token: string | undefined): string {
  let out = text;
  const secrets: string[] = [];
  if (token) secrets.push(token);
  try {
    const u = new URL(url);
    if (u.password.length >= 4) secrets.push(u.password, decodeURIComponent(u.password));
  } catch {
    // not a URL: nothing to take from it
  }
  for (const s of secrets) if (s) out = out.split(s).join("***");
  return out;
}

function errText(e: unknown): string {
  if (!(e instanceof Error)) return String(e);
  const c = (e as { cause?: unknown }).cause;
  const cs = c instanceof Error ? ((c as { code?: string }).code ?? c.message) : undefined;
  return cs ? `${e.message} (${cs})` : e.message;
}

export class McpClient {
  private readonly doFetch: typeof fetch;
  private readonly allowTool: ((name: string) => boolean) | undefined;
  private readonly log: McpLogger;
  private readonly clientName: string;
  private readonly clientVersion: string;
  private readonly shortMs: number;
  private readonly callMs: number;
  private session: McpSession | undefined;
  private lock: Promise<unknown> = Promise.resolve();
  private nextId = 1;
  private lastErr: string | undefined;

  constructor(opts: McpClientOptions = {}) {
    this.doFetch = opts.fetch ?? fetch;
    this.allowTool = opts.policy?.allowTool;
    this.log = opts.logger ?? NO_LOG;
    this.clientName = opts.clientName ?? "bantou-center-client";
    this.clientVersion = opts.clientVersion ?? "0.0.0";
    this.shortMs = opts.shortTimeoutMs ?? SHORT_TIMEOUT_MS;
    this.callMs = opts.callTimeoutMs ?? CALL_TIMEOUT_MS;
  }

  lastError(): string | undefined {
    return this.lastErr;
  }

  private id(): number {
    return this.nextId++;
  }

  /** Run `fn` after every earlier `withLock` has finished (the async mutex around the session). */
  private withLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.lock.then(fn, fn);
    this.lock = run.catch(() => undefined);
    return run;
  }

  private async post(
    url: string,
    token: string | undefined,
    session: McpSession | undefined,
    body: unknown,
    timeoutMs: number,
  ): Promise<Reply> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    };
    if (token !== undefined) headers.authorization = `Bearer ${token}`;
    if (session) {
      if (session.id !== undefined) headers[SESSION_HEADER] = session.id;
      headers["mcp-protocol-version"] = session.protocol;
    }
    const signal = AbortSignal.timeout(timeoutMs);
    let resp: Response;
    try {
      resp = await this.doFetch(fetchableUrl(url), { method: "POST", headers, body: JSON.stringify(body), signal });
    } catch (e) {
      throw new CenterMcpError(scrub(`${redactUrl(url)} に接続できない: ${errText(e)}`, url, token));
    }
    let text: string;
    try {
      text = await resp.text();
    } catch (e) {
      throw new CenterMcpError(scrub(`応答の読み取りに失敗: ${errText(e)}`, url, token));
    }
    return {
      status: resp.status,
      contentType: resp.headers.get("content-type") ?? "",
      sessionId: resp.headers.get(SESSION_HEADER) ?? undefined,
      body: text,
    };
  }

  /** The log line, with the secrets removed. */
  private warn(url: string, token: string | undefined, msg: string): void {
    this.log.warn(scrub(msg, url, token));
  }

  /** `initialize` + `notifications/initialized`. */
  private async initialize(url: string, token: string | undefined): Promise<McpSession> {
    const id = this.id();
    const req = {
      jsonrpc: "2.0",
      id,
      method: "initialize",
      params: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: this.clientName, version: this.clientVersion },
      },
    };
    let r: Reply;
    try {
      r = await this.post(url, token, undefined, req, this.shortMs);
    } catch (e) {
      this.warn(url, token, `center MCP initialize: ${(e as Error).message}`);
      throw e;
    }
    const ok = r.status >= 200 && r.status < 300;
    if (!ok) this.warn(url, token, `center MCP initialize: HTTP ${r.status}: ${clipBody(r.body)}`);
    if (r.status === 401) throw new CenterMcpError(unauthorized(url, token));
    if (!ok) {
      throw new CenterMcpError(
        scrub(`initialize が HTTP ${r.status} で失敗 (${redactUrl(url)}): ${snippet(r.body)}`, url, token),
      );
    }
    const result = pickResponse(parseMessages(r.contentType, r.body), id);
    const proto = isObj(result) && typeof result.protocolVersion === "string" ? result.protocolVersion : PROTOCOL_VERSION;
    const session: McpSession = { url, token, id: r.sessionId, protocol: proto };
    let n: Reply;
    try {
      n = await this.post(url, token, session, { jsonrpc: "2.0", method: "notifications/initialized" }, this.shortMs);
    } catch (e) {
      this.warn(url, token, `center MCP notifications/initialized: ${(e as Error).message}`);
      throw e;
    }
    if (n.status < 200 || n.status >= 300) {
      this.warn(url, token, `center MCP notifications/initialized: HTTP ${n.status}: ${clipBody(n.body)}`);
      throw new CenterMcpError(
        scrub(`initialized 通知が HTTP ${n.status} で失敗 (${redactUrl(url)}): ${snippet(n.body)}`, url, token),
      );
    }
    return session;
  }

  /** The live session for `url` + `token`, initializing when there is none (or it belongs to another URL or token). */
  private ensure(url: string, token: string | undefined): Promise<McpSession> {
    return this.withLock(async () => {
      const s = this.session;
      if (s && s.url === url && s.token === token) return s;
      this.session = undefined;
      const fresh = await this.initialize(url, token);
      this.session = fresh;
      return fresh;
    });
  }

  /** Forget `dead` unless a newer session has already replaced it. */
  private invalidate(dead: McpSession): Promise<void> {
    return this.withLock(async () => {
      const s = this.session;
      if (s && s.url === dead.url && s.id === dead.id) this.session = undefined;
    });
  }

  private async requestOnce(
    url: string,
    token: string | undefined,
    method: string,
    params: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<unknown> {
    const session = await this.ensure(url, token);
    const id = this.id();
    const req = { jsonrpc: "2.0", id, method, params };
    const what = typeof params.name === "string" ? `${method} ${params.name}` : method;
    let r: Reply;
    try {
      r = await this.post(url, token, session, req, timeoutMs);
    } catch (e) {
      this.warn(url, token, `center MCP ${what}: ${(e as Error).message}`);
      throw e;
    }
    const ok = r.status >= 200 && r.status < 300;
    if (ok) {
      // `ping` runs on every connection probe: only `tools/call` is logged when it works.
      if (method === "tools/call") this.log.info(`center MCP ${what}: HTTP ${r.status}`);
    } else {
      this.warn(url, token, `center MCP ${what}: HTTP ${r.status}: ${clipBody(r.body)}`);
    }
    if (r.status === 401) throw new CenterMcpError(unauthorized(url, token));
    if (r.status === 404 && session.id !== undefined) {
      await this.invalidate(session);
      throw new SessionGone();
    }
    if (!ok) {
      throw new CenterMcpError(
        scrub(`${method} が HTTP ${r.status} で失敗 (${redactUrl(url)}): ${snippet(r.body)}`, url, token),
      );
    }
    try {
      return pickResponse(parseMessages(r.contentType, r.body), id);
    } catch (e) {
      if (e instanceof CenterMcpError) throw new CenterMcpError(scrub(e.message, url, token));
      throw e;
    }
  }

  /** One JSON-RPC request; a lost session is re-established once. */
  private async request(
    url: string,
    token: string | undefined,
    method: string,
    params: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<unknown> {
    try {
      return await this.requestOnce(url, token, method, params, timeoutMs);
    } catch (e) {
      if (e instanceof SessionGone) return this.requestOnce(url, token, method, params, timeoutMs);
      throw e;
    }
  }

  /** Keep the message of a failure as `lastError`; a success clears it. Returns the user-facing message of a failure. */
  private failureMessage(e: unknown): string {
    return e instanceof SessionGone || e instanceof CenterMcpError ? e.message : String(e instanceof Error ? e.message : e);
  }

  /**
   * `tools/call`. Returns the MCP tool result (`content`, `isError`, ...) as is; a result with
   * `isError: true` throws a `CenterMcpError` carrying the tool's text. A tool outside `policy.allowTool`
   * throws `ToolNotAllowedError` without sending anything. (`call_tool`)
   */
  async callTool(url: string, token: string | undefined, name: string, args?: unknown): Promise<McpToolResult> {
    if (this.allowTool && !this.allowTool(name)) throw new ToolNotAllowedError(name);
    const params = { name, arguments: args ?? {} };
    let result: unknown;
    try {
      result = await this.request(url, token, "tools/call", params, this.callMs);
      this.lastErr = undefined;
    } catch (e) {
      const m = this.failureMessage(e);
      this.lastErr = m;
      throw new CenterMcpError(`${name}: ${m}`);
    }
    if (isObj(result) && result.isError === true) {
      const text = scrub(toolText(result), url, token);
      const msg = `${name} が失敗: ${text === "" ? "(no message)" : text}`;
      this.warn(url, token, `center MCP tools/call ${name}: tool error: ${clipBody(text)}`);
      this.lastErr = msg;
      throw new CenterMcpError(msg);
    }
    return result as McpToolResult;
  }

  /** `ping` against `url` (re-establishing the session if needed): resolves when the center answers. (`probe`) */
  async probe(url: string, token: string | undefined): Promise<void> {
    try {
      await this.request(url, token, "ping", {}, this.shortMs);
      this.lastErr = undefined;
    } catch (e) {
      const m = this.failureMessage(e);
      this.lastErr = m;
      throw new CenterMcpError(m);
    }
  }
}

/** `center_connection`: where we connect and whether the center answers now. `url` has no userinfo or query. */
export interface CenterConnection {
  url?: string;
  source?: Target["source"];
  connected: boolean;
  lastError?: string;
}

export interface CenterMcpOptions extends McpClientOptions {
  /** Where to connect, read on every call (`CenterSettingsHandle.selectTarget`). */
  settings: { selectTarget(): Promise<Target | undefined> };
}

/** The client bound to the settings: the target is chosen on every call, so a settings change takes effect on the next call. */
export interface CenterMcp {
  /** `center_call`: a tool by name; the MCP tool result as is. */
  call(name: string, args?: unknown): Promise<McpToolResult>;
  /** The JSON of a tool's text result (`center_json`). */
  json(tool: string, args?: unknown): Promise<unknown>;
  /** `center_connection`. */
  connection(): Promise<CenterConnection>;
  /** The client itself (for tests / advanced use). */
  readonly client: McpClient;
}

export function createCenterMcp(opts: CenterMcpOptions): CenterMcp {
  const client = new McpClient(opts);
  const target = async (): Promise<Target> => {
    const t = await opts.settings.selectTarget();
    if (!t) throw new CenterMcpError(NO_TARGET);
    return t;
  };
  return {
    client,
    async call(name, args) {
      const t = await target();
      return client.callTool(t.url, t.token, name, args);
    },
    async json(tool, args) {
      const t = await target();
      const r = await client.callTool(t.url, t.token, tool, args);
      const text = toolText(r, "");
      try {
        return JSON.parse(text);
      } catch (e) {
        throw new CenterMcpError(`${tool} の結果を読めない: ${(e as Error).message}`);
      }
    },
    async connection() {
      let t: Target | undefined;
      try {
        t = await opts.settings.selectTarget();
      } catch (e) {
        return { connected: false, lastError: (e as Error).message };
      }
      if (!t) return { connected: false, lastError: NO_TARGET };
      let connected = true;
      try {
        await client.probe(t.url, t.token);
      } catch {
        connected = false;
      }
      const c: CenterConnection = { url: redactUrl(t.url), source: t.source, connected };
      const le = client.lastError();
      if (le !== undefined) c.lastError = le;
      return c;
    },
  };
}
