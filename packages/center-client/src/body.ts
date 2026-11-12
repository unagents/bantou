// Reading a request body with a cap, before it is all in memory. Framework independent (a Node `IncomingMessage`).

import type { IncomingMessage } from "node:http";

export const MAX_BODY_BYTES = 1024 * 1024;
/** After the cap is passed, this many bytes (a multiple of the cap) are read and dropped so the 413 can still be answered. */
const DRAIN_FACTOR = 4;

export type BodyRead = { ok: true; text: string } | { ok: false };
export type BytesRead = { ok: true; bytes: Buffer } | { ok: false };

/**
 * `Content-Length` over the cap: not read at all. Otherwise the chunks are counted while they arrive: when the cap is
 * passed nothing is kept any more, the rest is dropped up to `cap * 4`, then reading stops (the answer carries
 * `Connection: close`). Memory use stays at the cap.
 */
export async function readBodyLimited(req: IncomingMessage, max = MAX_BODY_BYTES): Promise<BodyRead> {
  const r = await readBytesLimited(req, max);
  return r.ok ? { ok: true, text: r.bytes.toString("utf8") } : { ok: false };
}

/** `readBodyLimited` for a binary body (an upload): the same limits, the bytes as they are. */
export function readBytesLimited(req: IncomingMessage, max = MAX_BODY_BYTES): Promise<BytesRead> {
  const len = Number(req.headers["content-length"]);
  if (Number.isFinite(len) && len > max) return Promise.resolve({ ok: false });
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let over = false;
    const done = (r: BytesRead) => {
      req.off("data", onData);
      req.off("end", onEnd);
      req.off("error", onError);
      req.off("close", onClose);
      resolve(r);
    };
    const onData = (c: Buffer | string) => {
      total += typeof c === "string" ? Buffer.byteLength(c) : c.length;
      if (total > max) {
        over = true;
        chunks.length = 0;
        if (total > max * DRAIN_FACTOR) {
          req.pause();
          done({ ok: false });
        }
        return;
      }
      chunks.push(typeof c === "string" ? Buffer.from(c) : c);
    };
    const onEnd = () => done(over ? { ok: false } : { ok: true, bytes: Buffer.concat(chunks) });
    const onError = () => done({ ok: false });
    // closed before the whole body came (the client went away): not a body
    const onClose = () => done(over || !req.complete ? { ok: false } : { ok: true, bytes: Buffer.concat(chunks) });
    req.on("data", onData);
    req.on("end", onEnd);
    req.on("error", onError);
    req.on("close", onClose);
  });
}
