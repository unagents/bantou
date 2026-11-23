// GraphQL relay of the web backend (design 4 stage B). The browser POSTs a GraphQL document to the backend
// (`POST /api/graphql`); the backend adds the center's token and forwards it to the center's `/graphql`, then
// hands back the answer as it comes (a subscription is an SSE stream, so the body is not buffered).
// The token never reaches the browser. Framework independent: fetch only; the route layer sends the stream.

import { Readable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { centerUrl } from "./events.ts";
import { graphqlRefusal } from "./graphql-guard.ts";
import { redactUrl } from "./normalize.ts";
import type { Redactor } from "./redact.ts";
import type { Target } from "./settings.ts";

export const GRAPHQL_SEGMENT = "graphql";

/** The largest document taken: an image of 20 MB as base64 (4/3) plus the rest of the document. */
export const MAX_GRAPHQL_BYTES = Math.ceil((20 * 1024 * 1024) / 3) * 4 + 64 * 1024;

export interface GraphqlReply {
  status: number;
  /** `content-type` (and for a stream `cache-control`) only. */
  headers: Record<string, string>;
  /** The center's body as a stream (a JSON answer or an SSE stream). `close()` ends the center's request. */
  body: Readable;
  close(): void;
}

export interface GraphqlRelayOptions {
  getTarget: () => Promise<Target | undefined>;
  fetch?: typeof fetch;
  log?: { warn(msg: string): void };
  /** Cleans every answer of the secrets known to it (the center's token and the like) before the browser sees it. */
  redactor?: Redactor;
  /** The web's mutation allow-list and center-only settings refusal. On unless `false` (the desktop does not use this relay). */
  guard?: boolean;
}

export interface GraphqlRelay {
  /** Forward one POST. `accept` is the browser's (`text/event-stream` for a subscription). Never throws: a failure is a JSON `{ errors }` reply. */
  forward(body: string, accept: string | undefined): Promise<GraphqlReply>;
}

const jsonReply = (status: number, message: string): GraphqlReply => {
  const body = Readable.from([JSON.stringify({ errors: [{ message }] })]);
  return { status, headers: { "content-type": "application/json; charset=utf-8" }, body, close: () => body.destroy() };
};

/** A JSON answer: read whole, cleaned, sent as one piece (a secret cannot hide between chunks). */
function redactWhole(src: Readable, redactor: Redactor): Readable {
  return Readable.from(
    (async function* () {
      const chunks: Buffer[] = [];
      for await (const c of src) chunks.push(Buffer.from(c as Uint8Array));
      yield await redactor.text(Buffer.concat(chunks).toString("utf8"));
    })(),
  );
}

/** An SSE stream: cleaned frame by frame (a frame ends with a blank line), in order; the tail is flushed at the end. */
function redactFrames(src: Readable, redactor: Redactor): Readable {
  return Readable.from(
    (async function* () {
      const dec = new StringDecoder("utf8");
      let buf = "";
      for await (const c of src) {
        buf += dec.write(Buffer.from(c as Uint8Array));
        const parts = buf.split(/\r?\n\r?\n/);
        const ends = [...buf.matchAll(/\r?\n\r?\n/g)].map((m) => m[0]);
        buf = parts.pop() ?? "";
        for (let i = 0; i < parts.length; i++) yield await redactor.text(parts[i]! + ends[i]!);
      }
      buf += dec.end();
      if (buf !== "") yield await redactor.text(buf);
    })(),
  );
}

export function createGraphqlRelay(opts: GraphqlRelayOptions): GraphqlRelay {
  const doFetch = opts.fetch ?? fetch;
  return {
    async forward(body, accept) {
      if (Buffer.byteLength(body) > MAX_GRAPHQL_BYTES) return jsonReply(413, "body が大きすぎる");
      if (opts.guard !== false) {
        const refused = graphqlRefusal(body);
        if (refused) return jsonReply(refused.status, refused.message);
      }
      const target = await opts.getTarget();
      if (!target) return jsonReply(503, "center の接続先が無い");
      let url: URL;
      try {
        url = centerUrl(target.url, [GRAPHQL_SEGMENT]);
      } catch {
        return jsonReply(502, "center の URL が不正");
      }
      const ac = new AbortController();
      const headers: Record<string, string> = { "content-type": "application/json", accept: accept ?? "application/json" };
      if (target.token) headers.authorization = `Bearer ${target.token}`;
      let res: Response;
      try {
        res = await doFetch(url, { method: "POST", headers, body, signal: ac.signal, redirect: "manual" });
      } catch (e) {
        opts.log?.warn(`graphql: ${redactUrl(url.href)} につながらない: ${e instanceof Error ? e.message : String(e)}`);
        return jsonReply(502, "center につながらない");
      }
      const out: Record<string, string> = {};
      const ct = res.headers.get("content-type");
      if (ct) out["content-type"] = ct;
      if ((ct ?? "").startsWith("text/event-stream")) out["cache-control"] = "no-cache, no-transform";
      if (!res.body) return { status: res.status, headers: out, body: Readable.from([]), close: () => ac.abort() };
      const raw = Readable.fromWeb(res.body as never);
      // destroy() cancels the center's stream; an abort after that is not an error worth a crash
      raw.on("error", () => {});
      const redact = opts.redactor;
      if (!redact) return { status: res.status, headers: out, body: raw, close: () => raw.destroy() };
      const cleaned = (ct ?? "").startsWith("text/event-stream") ? redactFrames(raw, redact) : redactWhole(raw, redact);
      cleaned.on("error", () => {});
      return { status: res.status, headers: out, body: cleaned, close: () => { cleaned.destroy(); raw.destroy(); } };
    },
  };
}
