// Reading a request body with a cap, before it is all in memory. Framework independent (a Node `IncomingMessage`).

import type { IncomingMessage } from "node:http";

export const MAX_BODY_BYTES = 1024 * 1024;
/** After the cap is passed, this many bytes (a multiple of the cap) are read and dropped so the 413 can still be answered. */
const DRAIN_FACTOR = 4;

export type BodyRead = { ok: true; text: string } | { ok: false };

/**
 * `Content-Length` over the cap: not read at all. Otherwise the chunks are counted while they arrive: when the cap is
 * passed nothing is kept any more, the rest is dropped up to `cap * 4`, then reading stops (the answer carries
 * `Connection: close`). Memory use stays at the cap.
 */
export function readBodyLimited(req: IncomingMessage, max = MAX_BODY_BYTES): Promise<BodyRead> {
  const len = Number(req.headers["content-length"]);
  if (Number.isFinite(len) && len > max) return Promise.resolve({ ok: false });
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let over = false;
    const done = (r: BodyRead) => {
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
    const onEnd = () => done(over ? { ok: false } : { ok: true, text: Buffer.concat(chunks).toString("utf8") });
    const onError = () => done({ ok: false });
    const onClose = () => done(over ? { ok: false } : { ok: true, text: Buffer.concat(chunks).toString("utf8") });
    req.on("data", onData);
    req.on("end", onEnd);
    req.on("error", onError);
    req.on("close", onClose);
  });
}
