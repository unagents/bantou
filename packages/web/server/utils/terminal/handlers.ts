import {
  createError,
  defineEventHandler,
  getHeader,
  getQuery,
  getRouterParam,
  readRawBody,
  type EventHandler,
  type H3Event,
} from "h3";
import { MAX_ATTACHMENT_BYTES, TerminalError, checkSessionName, sniffType } from "bantou-center-client";
import type { TerminalService } from "../center";

/** 薄い route の本体。検査は center-client（と center）が行い、ここは HTTP への写しだけ。 */

export const KEEPALIVE_MS = 15_000;
const JSON_MAX_BYTES = 1024 * 1024;
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

/** TerminalError → HTTP。4xx はそのまま（center の 401/403 は center への認証の問題でブラウザの問題ではないので 502）、それ以外（到達不可・接続先なし・5xx）は 502。文は scrub 済み。 */
export function toHttpError(e: unknown) {
  if (e instanceof TerminalError) {
    const s = e.status;
    const code = s !== undefined && s >= 400 && s < 500 && s !== 401 && s !== 403 ? s : 502;
    return createError({ statusCode: code, statusMessage: code === 502 ? "center_error" : "request_refused", data: { error: e.message } });
  }
  return createError({ statusCode: 500, statusMessage: "terminal_error" });
}

function sessionName(event: H3Event): string {
  try {
    return checkSessionName(getRouterParam(event, "name"));
  } catch (e) {
    throw toHttpError(e);
  }
}

async function readJsonBody(event: H3Event): Promise<Record<string, unknown>> {
  const len = Number(getHeader(event, "content-length") ?? "0");
  if (len > JSON_MAX_BYTES) throw createError({ statusCode: 413, statusMessage: "too_large" });
  const raw = await readRawBody(event, "utf8");
  if (raw === undefined || raw.length > JSON_MAX_BYTES) throw createError({ statusCode: 400, statusMessage: "bad_request", data: { error: "body が無い／大きすぎる" } });
  try {
    const v: unknown = JSON.parse(raw);
    if (typeof v === "object" && v !== null && !Array.isArray(v)) return v as Record<string, unknown>;
  } catch {
    // fallthrough
  }
  throw createError({ statusCode: 400, statusMessage: "bad_request", data: { error: "body は JSON object" } });
}

/** `Last-Event-ID`（再接続）を優先し、無ければ `?after=`。どちらも 10 進の整数のみ。 */
function afterOf(event: H3Event): number | undefined {
  const raw = (getHeader(event, "last-event-id") ?? "").trim() || String(getQuery(event).after ?? "").trim();
  if (raw === "") return undefined;
  const n = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(n)) throw createError({ statusCode: 400, statusMessage: "bad_request", data: { error: "after は 0 以上の整数" } });
  return n;
}

export function createOutputHandler(getService: () => TerminalService): EventHandler {
  return defineEventHandler(async (event) => {
    const name = sessionName(event);
    const after = afterOf(event);
    const svc = getService();
    const res = event.node.res;
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      "x-accel-buffering": "no",
    });
    res.flushHeaders();
    res.write(": ok\n\n"); // header を即 flush
    const write = (s: string) => {
      if (!res.writableEnded && !res.destroyed) res.write(s);
    };
    const ka = setInterval(() => write(": ka\n\n"), KEEPALIVE_MS);
    let sub: { stop(): void } | undefined;
    await new Promise<void>((done) => {
      res.once("close", done);
      sub = svc.terminals.openOutput(name, {
        ...(after !== undefined ? { after } : {}),
        onOutput: (p) => write(p.reset ? "event: reset\ndata: \n\n" : `id: ${p.id}\nevent: output\ndata: ${p.data}\n\n`),
        onStatus: (s) => {
          write(`event: status\ndata: ${JSON.stringify(s)}\n\n`);
          if (s.state === "rejected") res.end();
        },
      });
    });
    clearInterval(ka);
    sub?.stop();
    event._handled = true;
  });
}

export function createInputHandler(getService: () => TerminalService): EventHandler {
  return defineEventHandler(async (event) => {
    const name = sessionName(event);
    const body = await readJsonBody(event);
    try {
      await getService().terminals.input(name, body.data as string);
    } catch (e) {
      throw toHttpError(e);
    }
    return { ok: true };
  });
}

export function createResizeHandler(getService: () => TerminalService): EventHandler {
  return defineEventHandler(async (event) => {
    const name = sessionName(event);
    const body = await readJsonBody(event);
    try {
      await getService().terminals.resize(name, body.cols as number, body.rows as number);
    } catch (e) {
      throw toHttpError(e);
    }
    return { ok: true };
  });
}

/** 画像 1 枚（body がそのまま bytes）。型は Content-Type と先頭 bytes の両方で見る。20MB 超は読む途中で 413。 */
export function createAttachmentsHandler(getService: () => TerminalService): EventHandler {
  return defineEventHandler(async (event) => {
    const name = sessionName(event);
    const type = (getHeader(event, "content-type") ?? "").split(";")[0]!.trim().toLowerCase();
    if (!IMAGE_TYPES.has(type)) throw createError({ statusCode: 415, statusMessage: "unsupported_media_type", data: { error: "png / jpeg / gif / webp のみ" } });
    const declared = Number(getHeader(event, "content-length") ?? "0");
    if (declared > MAX_ATTACHMENT_BYTES) throw createError({ statusCode: 413, statusMessage: "too_large" });
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const c of event.node.req as AsyncIterable<Buffer>) {
      total += c.length;
      if (total > MAX_ATTACHMENT_BYTES) {
        event.node.req.destroy();
        throw createError({ statusCode: 413, statusMessage: "too_large" });
      }
      chunks.push(c);
    }
    if (total === 0) throw createError({ statusCode: 400, statusMessage: "bad_request", data: { error: "空のファイル" } });
    const data = new Uint8Array(Buffer.concat(chunks));
    if (sniffType(data) !== type) throw createError({ statusCode: 415, statusMessage: "unsupported_media_type", data: { error: "画像の型が違う" } });
    try {
      const out = await getService().attachments.attachBytes(name, [{ name: "image", data }]);
      if (out.saved.length === 0) throw createError({ statusCode: 502, statusMessage: "center_error", data: out });
      return out;
    } catch (e) {
      if (e && typeof e === "object" && "statusCode" in e) throw e;
      throw toHttpError(e);
    }
  });
}
