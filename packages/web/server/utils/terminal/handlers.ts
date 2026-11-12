import {
  createError,
  defineEventHandler,
  getHeader,
  getQuery,
  getRouterParam,
  setResponseHeader,
  type EventHandler,
  type H3Event,
} from "h3";
import {
  MAX_ATTACHMENT_BYTES,
  MAX_BODY_BYTES,
  TerminalError,
  checkInputData,
  checkSessionName,
  readBytesLimited,
  sniffType,
  type CenterClient,
} from "bantou-center-client";

/** 薄い route の本体。検査は center-client（と center）が行い、ここは HTTP への写しだけ。 */

export const KEEPALIVE_MS = 15_000;
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

/** TerminalError → HTTP。4xx はそのまま（center の 401/403 は center への認証の問題でブラウザの問題ではないので 502）、それ以外（到達不可・接続先なし・5xx）は 502。文は scrub 済みで、さらに center-client の redactor を通す。 */
export async function toHttpError(c: CenterClient, e: unknown) {
  if (e instanceof TerminalError) {
    const s = e.status;
    const code = s !== undefined && s >= 400 && s < 500 && s !== 401 && s !== 403 ? s : 502;
    return createError({ statusCode: code, statusMessage: code === 502 ? "center_error" : "request_refused", data: { error: await c.redactor.text(e.message) } });
  }
  return createError({ statusCode: 500, statusMessage: "terminal_error" });
}

async function sessionName(c: CenterClient, event: H3Event): Promise<string> {
  try {
    return checkSessionName(getRouterParam(event, "name"));
  } catch (e) {
    throw await toHttpError(c, e);
  }
}

/** body を center-client の readBytesLimited で受ける（上限は受信中に守る。Content-Length 超過は読まずに 413）。413 の応答は接続を閉じる。 */
async function readBytes413(event: H3Event, max: number): Promise<Buffer> {
  const r = await readBytesLimited(event.node.req, max);
  if (r.ok) return r.bytes;
  setResponseHeader(event, "connection", "close");
  throw createError({ statusCode: 413, statusMessage: "too_large" });
}

async function readJsonBody(event: H3Event): Promise<Record<string, unknown>> {
  const raw = (await readBytes413(event, MAX_BODY_BYTES)).toString("utf8");
  if (raw === "") throw createError({ statusCode: 400, statusMessage: "bad_request", data: { error: "body が無い" } });
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

export function createOutputHandler(getClient: () => CenterClient): EventHandler {
  return defineEventHandler(async (event) => {
    const c = getClient();
    const name = await sessionName(c, event);
    const after = afterOf(event);
    await c.redactor.text(""); // いまの接続先の secret を redactor に覚えさせる（status の文に使う）
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
      sub = c.terminal.openOutput(name, {
        ...(after !== undefined ? { after } : {}),
        onOutput: (p) => {
          if (p.reset) return write("event: reset\ndata: \n\n");
          // data は base64 のはず。外れた chunk は流さず（改行で別の SSE 行が混ざる）、stream を閉じる
          try {
            checkInputData(p.data);
          } catch {
            write(`event: status\ndata: ${JSON.stringify({ session: name, state: "rejected", message: "center の出力の形式が不正" })}\n\n`);
            res.end();
            return;
          }
          write(`id: ${p.id}\nevent: output\ndata: ${p.data}\n\n`);
        },
        onStatus: (s) => {
          write(c.redactor.textSync(`event: status\ndata: ${JSON.stringify(s)}\n\n`));
          if (s.state === "rejected") res.end();
        },
      });
    });
    clearInterval(ka);
    sub?.stop();
    event._handled = true;
  });
}

export function createInputHandler(getClient: () => CenterClient): EventHandler {
  return defineEventHandler(async (event) => {
    const c = getClient();
    const name = await sessionName(c, event);
    const body = await readJsonBody(event);
    try {
      await c.terminal.input(name, body.data as string);
    } catch (e) {
      throw await toHttpError(c, e);
    }
    return { ok: true };
  });
}

export function createResizeHandler(getClient: () => CenterClient): EventHandler {
  return defineEventHandler(async (event) => {
    const c = getClient();
    const name = await sessionName(c, event);
    const body = await readJsonBody(event);
    try {
      await c.terminal.resize(name, body.cols as number, body.rows as number);
    } catch (e) {
      throw await toHttpError(c, e);
    }
    return { ok: true };
  });
}

/** 画像 1 枚（body がそのまま bytes）。型は Content-Type と先頭 bytes の両方で見る。20MB 超は読む途中で 413。 */
export function createAttachmentsHandler(getClient: () => CenterClient): EventHandler {
  return defineEventHandler(async (event) => {
    const c = getClient();
    const name = await sessionName(c, event);
    const type = (getHeader(event, "content-type") ?? "").split(";")[0]!.trim().toLowerCase();
    if (!IMAGE_TYPES.has(type)) throw createError({ statusCode: 415, statusMessage: "unsupported_media_type", data: { error: "png / jpeg / gif / webp のみ" } });
    const body = await readBytes413(event, MAX_ATTACHMENT_BYTES);
    if (body.length === 0) throw createError({ statusCode: 400, statusMessage: "bad_request", data: { error: "空のファイル" } });
    const data = new Uint8Array(body);
    if (sniffType(data) !== type) throw createError({ statusCode: 415, statusMessage: "unsupported_media_type", data: { error: "画像の型が違う" } });
    try {
      const out = await c.redactor.value(await c.attachments.attachBytes(name, [{ name: "image", data }]));
      if (out.saved.length === 0) throw createError({ statusCode: 502, statusMessage: "center_error", data: out });
      return out;
    } catch (e) {
      if (e && typeof e === "object" && "statusCode" in e) throw e;
      throw await toHttpError(c, e);
    }
  });
}
