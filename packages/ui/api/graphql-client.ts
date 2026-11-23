// GraphQL client of the screens (design 3.2 / 3.3, stage B). One POST per query / mutation; a subscription is an SSE
// stream of the same endpoint (graphql-yoga "distinct connections": POST with `Accept: text/event-stream`, events `next` /
// `complete`). No Tauri / Nuxt import: where the endpoint is comes from `target` (desktop: the center in use, with its Bearer;
// web: the backend's `/api/graphql`, which adds the token). Tested with a fake `fetch`.

export interface GraphqlTarget {
  url: string;
  headers?: Record<string, string>;
}

export interface GraphqlClientOptions {
  target: () => Promise<GraphqlTarget>;
  fetch?: typeof fetch;
  /** Wait before reconnect attempt `n` (0-based). */
  reconnectDelayMs?: (n: number) => number;
}

/** A failed operation: `message` is the server's (or the transport's) text alone, like the string a Tauri `invoke` rejects with. */
export class GraphqlError extends Error {
  /** `extensions.code` of the first error (BAD_USER_INPUT, NOT_FOUND, OPERATION_FAILED …). */
  readonly code?: string;
  /** HTTP status when the failure was an HTTP answer. */
  readonly status?: number;
  constructor(message: string, code?: string, status?: number) {
    super(message);
    this.name = "GraphqlError";
    this.code = code;
    this.status = status;
  }
  override toString(): string {
    return this.message;
  }
}

interface GraphqlResult<T> {
  data?: T | null;
  errors?: { message?: string; extensions?: { code?: string } }[];
}

function errorOf(r: GraphqlResult<unknown>, status?: number): GraphqlError {
  const first = r.errors?.[0];
  return new GraphqlError(first?.message ?? (status ? `HTTP ${status}` : "GraphQL error"), first?.extensions?.code, status);
}

export interface SubscribeHandlers<T> {
  onNext(data: T): void;
  /** The stream is open (also after a reconnect: `reconnected` true — a change in between has no event, so read again). */
  onOpen?(reconnected: boolean): void;
  /** The stream broke and will be retried (`retrying`), or was refused and is given up (`rejected`). */
  onStatus?(state: "retrying" | "rejected", message: string | null): void;
}

/** Wait before reconnect attempt `n` (0-based): 1, 2, 4, 8, then 15 s (the same as the center-client's event stream). */
export const defaultReconnectDelayMs = (n: number) => Math.min(15_000, 1000 * 2 ** n);

export interface GraphqlClient {
  request<T>(query: string, variables?: Record<string, unknown>): Promise<T>;
  /** `variables` is read at each (re)connect, so a resume point (`after`) can move. Returns the function that stops it. */
  subscribe<T>(query: string, variables: () => Record<string, unknown>, handlers: SubscribeHandlers<T>): () => void;
}

export function createGraphqlClient(opts: GraphqlClientOptions): GraphqlClient {
  const doFetch = (...a: Parameters<typeof fetch>) => (opts.fetch ?? fetch)(...a);
  const delayOf = opts.reconnectDelayMs ?? defaultReconnectDelayMs;

  async function post(query: string, variables: Record<string, unknown> | undefined, accept: string, signal?: AbortSignal): Promise<Response> {
    const t = await opts.target();
    try {
      return await doFetch(t.url, {
        method: "POST",
        headers: { "content-type": "application/json", accept, ...t.headers },
        body: JSON.stringify({ query, variables: variables ?? {} }),
        cache: "no-store",
        // An expired Access session answers with a redirect to a login page: keep it visible instead of following it.
        redirect: "manual",
        signal,
      });
    } catch (e) {
      if (signal?.aborted) throw e;
      throw new GraphqlError(`つながらない: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  async function request<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
    const res = await post(query, variables, "application/json");
    if (res.type === "opaqueredirect") throw new GraphqlError("ログインが必要", undefined, 0);
    const text = await res.text();
    let json: GraphqlResult<T> | undefined;
    try {
      json = text === "" ? undefined : (JSON.parse(text) as GraphqlResult<T>);
    } catch {
      json = undefined;
    }
    if (!json || typeof json !== "object") {
      throw new GraphqlError(res.ok ? "応答が JSON でない（ログイン画面かもしれない）" : `HTTP ${res.status}`, undefined, res.status);
    }
    if (json.errors?.length) throw errorOf(json, res.status);
    if (!res.ok) throw new GraphqlError(`HTTP ${res.status}`, undefined, res.status);
    if (json.data === undefined || json.data === null) throw new GraphqlError("応答に data が無い", undefined, res.status);
    return json.data;
  }

  function subscribe<T>(query: string, variables: () => Record<string, unknown>, h: SubscribeHandlers<T>): () => void {
    const ac = new AbortController();
    let attempt = 0;
    let everOpen = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const retry = (message: string | null) => {
      if (ac.signal.aborted) return;
      h.onStatus?.("retrying", message);
      timer = setTimeout(() => void run(), delayOf(attempt++));
    };

    async function run(): Promise<void> {
      if (ac.signal.aborted) return;
      let res: Response;
      try {
        res = await post(query, variables(), "text/event-stream", ac.signal);
      } catch (e) {
        retry(e instanceof Error ? e.message : String(e));
        return;
      }
      if (res.type === "opaqueredirect" || res.status === 401 || res.status === 403) {
        h.onStatus?.("rejected", res.type === "opaqueredirect" ? "ログインが必要" : `HTTP ${res.status}`);
        return;
      }
      if (!res.ok || !res.body) {
        retry(`HTTP ${res.status}`);
        return;
      }
      if (!(res.headers.get("content-type") ?? "").startsWith("text/event-stream")) {
        // The answer is a plain JSON (an error of the document): a retry would only repeat it.
        const text = await res.text().catch(() => "");
        let message = `HTTP ${res.status}`;
        try {
          message = errorOf(JSON.parse(text) as GraphqlResult<unknown>, res.status).message;
        } catch {
          // keep the status
        }
        h.onStatus?.("rejected", message);
        return;
      }
      h.onOpen?.(everOpen);
      everOpen = true;
      attempt = 0;
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      let finished = false;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          let at: number;
          while ((at = buf.search(/\r?\n\r?\n/)) >= 0) {
            const raw = buf.slice(0, at);
            buf = buf.slice(at + (buf[at] === "\r" ? 4 : 2));
            let event = "message";
            const data: string[] = [];
            for (const line of raw.split(/\r?\n/)) {
              if (line.startsWith(":")) continue;
              if (line.startsWith("event:")) event = line.slice(6).trim();
              else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
            }
            if (event === "complete") {
              finished = true;
            } else if (event === "next" && data.length > 0) {
              let r: GraphqlResult<T> | undefined;
              try {
                r = JSON.parse(data.join("\n")) as GraphqlResult<T>;
              } catch {
                r = undefined;
              }
              if (r?.data) h.onNext(r.data);
              else if (r?.errors?.length) h.onStatus?.("retrying", errorOf(r).message);
            }
          }
        }
      } catch (e) {
        if (ac.signal.aborted) return;
        retry(e instanceof Error ? e.message : String(e));
        return;
      }
      // The server ended the stream: a `complete` is a normal end of the operation, anything else is a drop. Both reconnect
      // (the screens' streams are meant to stay open).
      retry(finished ? null : "stream closed");
    }

    void run();
    return () => {
      ac.abort();
      clearTimeout(timer);
    };
  }

  return { request, subscribe };
}
