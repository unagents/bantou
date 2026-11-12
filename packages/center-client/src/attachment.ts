// Image attachments for a center session: the bytes go to the center host
// (`POST /sessions/<name>/attachments`), then the saved absolute path is typed into the session's
// pty (` <path> `, no Enter). Mirrors `packages/desktop/src-tauri/src/attachment.rs` for the byte
// source (clipboard / upload). The file-path and file-dialog sources are desktop only (no fs here).

import { redactUrl } from "./normalize.ts";
import type { Target } from "./settings.ts";
import { checkSessionName, clipBody, scrub, sessionUrl, TerminalError, type Logger, type Terminals } from "./terminal.ts";

/** One image at most 20 MB (the center refuses more). */
export const MAX_BYTES = 20 * 1024 * 1024;
export const UPLOAD_TIMEOUT_MS = 120_000;
const TYPES_HINT = "png / jpeg / gif / webp のみ";

/** What the caller shows: the paths typed into the pty, and one short line per refusal (same shape as `AttachOutcome` in packages/ui). */
export interface AttachOutcome {
  saved: string[];
  errors: string[];
}

/** The center's answer to a saved image. */
export interface Saved {
  path: string;
  bytes: number;
  type: string;
}

const startsWith = (b: Uint8Array, p: ArrayLike<number>): boolean => b.length >= p.length && Array.from({ length: p.length }, (_, i) => b[i] === p[i]).every(Boolean);
const ascii = (s: string): number[] => [...s].map((c) => c.charCodeAt(0));

/** Image type from the first bytes (the declared type / extension is not trusted). */
export function sniffType(b: Uint8Array): string | undefined {
  if (startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (startsWith(b, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (startsWith(b, ascii("GIF87a")) || startsWith(b, ascii("GIF89a"))) return "image/gif";
  if (b.length >= 12 && startsWith(b, ascii("RIFF")) && startsWith(b.subarray(8), ascii("WEBP"))) return "image/webp";
  return undefined;
}

const mb = (n: number) => Math.floor(n / 1024 / 1024);

/** A reason when a file of `len` bytes is too big or empty. */
export function checkSize(len: number): string | undefined {
  if (len === 0) return "空のファイル";
  if (len > MAX_BYTES) return `${mb(MAX_BYTES)}MB を超えている（1 枚 ${mb(MAX_BYTES)}MB まで）`;
  return undefined;
}

/** The text typed into the pty: every path with one space before and after, joined by spaces. */
export const inputText = (paths: string[]): string => ` ${paths.join(" ")} `;

export const toBase64 = (b: Uint8Array): string => Buffer.from(b).toString("base64");

/** Check clipboard / upload bytes; `Error` text is the short reason shown to the user. */
export function loadBytes(name: string, data: Uint8Array): { name: string; data: Uint8Array; kind: string } {
  const bad = checkSize(data.length);
  if (bad) throw new TerminalError(`${name}: ${bad}`);
  const kind = sniffType(data);
  if (!kind) throw new TerminalError(`${name}: 画像の型が違う（${TYPES_HINT}）`);
  return { name, data, kind };
}

/** The center's error text out of a response body (`{"error": "..."}`), else the clipped body. */
export function errorReason(body: string): string {
  let r: string | undefined;
  try {
    const v: unknown = JSON.parse(body);
    const e = (v as { error?: unknown } | null)?.error;
    if (typeof e === "string") r = e;
  } catch {
    // not JSON
  }
  return [...(r ?? clipBody(body))].slice(0, 200).join("");
}

export interface UploadOptions {
  fetch?: typeof fetch;
  target: Target;
  session: string;
  data: Uint8Array;
  kind: string;
  timeoutMs?: number;
}

/** Upload one image; the result is what the center saved. Nothing of the body goes to the log. */
export async function upload(o: UploadOptions): Promise<Saved> {
  const url = sessionUrl(o.target.url, o.session, "attachments");
  const where = redactUrl(url);
  const tok = o.target.token;
  const headers: Record<string, string> = { "content-type": o.kind };
  if (tok) headers.authorization = `Bearer ${tok}`;
  let resp: Response;
  try {
    resp = await (o.fetch ?? fetch)(url, {
      method: "POST",
      headers,
      body: o.data as BodyInit,
      signal: AbortSignal.timeout(o.timeoutMs ?? UPLOAD_TIMEOUT_MS),
    });
  } catch (e) {
    const c = (e as { cause?: { code?: unknown } }).cause?.code;
    throw new TerminalError(scrub(`${where} に接続できない: ${typeof c === "string" ? c : e instanceof Error ? e.message : String(e)}`, tok));
  }
  const text = await resp.text().catch(() => "");
  if (!resp.ok) throw new TerminalError(scrub(`center が ${resp.status} を返した: ${errorReason(text)}`, tok), resp.status);
  try {
    const v = JSON.parse(text) as Partial<Saved>;
    if (typeof v.path !== "string" || typeof v.bytes !== "number" || typeof v.type !== "string") throw new Error("shape");
    return { path: v.path, bytes: v.bytes, type: v.type };
  } catch (e) {
    throw new TerminalError(`center の応答が読めない: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export interface AttachmentsOptions {
  fetch?: typeof fetch;
  log?: Logger;
}

export interface ByteSource {
  name: string;
  data: Uint8Array;
}

/** `session_attach_bytes`-like handler: upload each image, then type the saved paths into the pty. */
export function createAttachments(terminals: Terminals, opts: AttachmentsOptions = {}) {
  const log = opts.log;
  return {
    async attachBytes(sessionName: string, sources: ByteSource[]): Promise<AttachOutcome> {
      const session = checkSessionName(sessionName);
      const target = await terminals.getTarget();
      const out: AttachOutcome = { saved: [], errors: [] };
      for (const src of sources) {
        let loaded: ReturnType<typeof loadBytes>;
        try {
          loaded = loadBytes(src.name, src.data);
        } catch (e) {
          const m = (e as Error).message;
          log?.warn(`attachment [${session}]: refused: ${m}`);
          out.errors.push(m);
          continue;
        }
        try {
          const s = await upload({ fetch: opts.fetch, target, session, data: loaded.data, kind: loaded.kind });
          log?.info(`attachment [${session}]: saved ${s.path} (${s.bytes} bytes, ${s.type})`);
          out.saved.push(s.path);
        } catch (e) {
          const m = (e as Error).message;
          log?.warn(`attachment [${session}]: ${loaded.name}: ${m}`);
          out.errors.push(`${loaded.name}: ${m}`);
        }
      }
      if (out.saved.length > 0) {
        try {
          await terminals.input(session, toBase64(new TextEncoder().encode(inputText(out.saved))));
        } catch (e) {
          const m = (e as Error).message;
          log?.warn(`attachment [${session}]: paths saved but typing them failed: ${m}`);
          out.errors.push(`path は保存したが入力に書けなかった: ${m}`);
        }
      }
      return out;
    },
  };
}
