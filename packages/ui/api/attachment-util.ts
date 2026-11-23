// Pure helpers of the clipboard image attachment (no Tauri / Nuxt import: tested on their own).

/** The image types the center takes (it checks the bytes against the type too). */
export function sniffImageType(b: Uint8Array): string | undefined {
  const at = (off: number, bytes: number[]) => bytes.every((v, i) => b[off + i] === v);
  if (at(0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (at(0, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (at(0, [0x47, 0x49, 0x46, 0x38, 0x37, 0x61]) || at(0, [0x47, 0x49, 0x46, 0x38, 0x39, 0x61])) return "image/gif";
  if (b.length >= 12 && at(0, [0x52, 0x49, 0x46, 0x46]) && at(8, [0x57, 0x45, 0x42, 0x50])) return "image/webp";
  return undefined;
}

export function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/** The text typed into the pty: every path with one space before and after, joined by spaces (no Enter). */
export const inputText = (paths: string[]): string => ` ${paths.join(" ")} `;
