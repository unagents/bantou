// Pure part of the terminal store (no Nuxt / Tauri imports, so a node spec can import it).

/** Per-session replay buffer (decoded bytes). Oldest chunks are dropped past this. */
export const BUFFER_LIMIT = 2 * 1024 * 1024;

export function decodeBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function encodeBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

/** Output of one session: the chunks kept for replay and the last received chunk id. */
export class SessionBuffer {
  chunks: Uint8Array[] = [];
  bytes = 0;
  lastId: number | null = null;

  clear() {
    this.chunks = [];
    this.bytes = 0;
    this.lastId = null;
  }

  /** Append a chunk; false when it is a repeat (id not newer than the last received). */
  push(id: number, data: Uint8Array, limit = BUFFER_LIMIT): boolean {
    if (this.lastId !== null && id <= this.lastId) return false;
    this.lastId = id;
    this.chunks.push(data);
    this.bytes += data.length;
    // Keep the newest chunk even when it alone exceeds the limit.
    while (this.bytes > limit && this.chunks.length > 1) this.bytes -= this.chunks.shift()!.length;
    return true;
  }
}
