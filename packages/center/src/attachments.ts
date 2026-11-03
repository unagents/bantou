import { mkdir, open } from "node:fs/promises";
import { join, resolve, sep } from "node:path";

/** 受ける画像の型と拡張子。 */
export const ATTACHMENT_TYPES: Readonly<Record<string, string>> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};

/** 1 枚の上限（20MB）。 */
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

/** 同じ秒に置ける枚数の上限（連番は 2 桁）。 */
const MAX_SEQ = 99;

export class AttachmentError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Content-Type から型だけを取り出す（`; charset=` などは捨てる。小文字化）。 */
export const mediaType = (header: string | undefined): string => (header ?? "").split(";", 1)[0].trim().toLowerCase();

/** 先頭バイトが宣言した型の画像か（Content-Type の偽装対策）。 */
export function matchesMagic(type: string, b: Buffer): boolean {
  switch (type) {
    case "image/png":
      return b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    case "image/jpeg":
      return b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
    case "image/gif": {
      const h = b.subarray(0, 6).toString("latin1");
      return h === "GIF87a" || h === "GIF89a";
    }
    case "image/webp":
      return b.length >= 12 && b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP";
    default:
      return false;
  }
}

const p2 = (n: number): string => String(n).padStart(2, "0");

/** `yyyymmdd-HHMMSS`（center ホストのローカル時刻）。 */
export const stamp = (d: Date): string =>
  `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`;

export interface SavedAttachment {
  path: string;
  bytes: number;
  type: string;
}

/**
 * `<workspace>/<session>/attachments/<yyyymmdd-HHMMSS>-<NN>.<ext>` に書く。
 * 既存は上書きせず、連番を 01 から探す。session 名は呼び出し側で `[A-Za-z0-9_-]+` を検証済みだが、ここでも配下か確かめる。
 */
export async function saveAttachment(opts: {
  workspace: string;
  session: string;
  type: string;
  body: Buffer;
  now?: Date;
}): Promise<SavedAttachment> {
  const ext = ATTACHMENT_TYPES[opts.type];
  if (!ext) throw new AttachmentError(415, `未対応の型: ${opts.type || "(なし)"}`);
  const root = resolve(opts.workspace);
  const dir = resolve(join(root, opts.session, "attachments"));
  if (!dir.startsWith(root + sep)) throw new AttachmentError(400, "session 名が不正");
  await mkdir(dir, { recursive: true });
  const base = stamp(opts.now ?? new Date());
  for (let seq = 1; seq <= MAX_SEQ; seq++) {
    const path = join(dir, `${base}-${p2(seq)}.${ext}`);
    let fh;
    try {
      fh = await open(path, "wx");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EEXIST") continue;
      throw e;
    }
    try {
      await fh.writeFile(opts.body);
    } finally {
      await fh.close();
    }
    return { path, bytes: opts.body.length, type: opts.type };
  }
  throw new AttachmentError(409, "同じ秒の連番が尽きた。少し待って再送する");
}

/** ボディを上限つきで読む。超えたら読むのをやめて AttachmentError(413)。 */
export function readBytes(req: import("node:http").IncomingMessage, max: number): Promise<Buffer> {
  return new Promise((resolveBody, reject) => {
    if (Number(req.headers["content-length"]) > max) {
      reject(new AttachmentError(413, `1 枚 ${max / 1024 / 1024}MB まで`));
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let failed = false;
    req.on("data", (c: Buffer) => {
      if (failed) return;
      size += c.length;
      if (size > max) {
        failed = true;
        chunks.length = 0;
        reject(new AttachmentError(413, `1 枚 ${max / 1024 / 1024}MB まで`));
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (!failed) resolveBody(Buffer.concat(chunks));
    });
    req.on("error", reject);
  });
}
