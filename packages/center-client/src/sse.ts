// Incremental parser for `text/event-stream`. Mirrors `SseParser` of
// `packages/desktop/src-tauri/src/terminal.rs` (WHATWG rules). No fs / network here.

/** One dispatched SSE event. */
export interface SseEvent {
  id?: string;
  /** `message` when the stream gave no `event:` field. */
  event: string;
  data: string;
}

/**
 * `\n`, `\r\n` or `\r` line ends, `:` comment lines, multi-line `data`; a blank line dispatches
 * (nothing is dispatched without data).
 */
export class SseParser {
  private buf: number[] = [];
  private id: string | undefined;
  private event: string | undefined;
  private data: string[] = [];
  /** A trailing `\r` was the last byte: a following `\n` belongs to it. */
  private skipLf = false;
  private readonly decoder = new TextDecoder("utf-8", { fatal: false });

  feed(bytes: Uint8Array | string): SseEvent[] {
    const input = typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes;
    const out: SseEvent[] = [];
    for (const b of input) {
      if (this.skipLf) {
        this.skipLf = false;
        if (b === 0x0a) continue;
      }
      if (b === 0x0a) this.line(out);
      else if (b === 0x0d) {
        this.skipLf = true;
        this.line(out);
      } else this.buf.push(b);
    }
    return out;
  }

  private line(out: SseEvent[]): void {
    const line = this.decoder.decode(Uint8Array.from(this.buf));
    this.buf = [];
    if (line === "") {
      const event = this.event;
      this.event = undefined;
      if (this.data.length > 0) {
        const ev: SseEvent = { event: event ? event : "message", data: this.data.join("\n") };
        if (this.id !== undefined) ev.id = this.id;
        out.push(ev);
      }
      this.data = [];
      return;
    }
    if (line.startsWith(":")) return; // comment / keep-alive
    const i = line.indexOf(":");
    let field = line;
    let value = "";
    if (i >= 0) {
      field = line.slice(0, i);
      value = line.slice(i + 1);
      if (value.startsWith(" ")) value = value.slice(1);
    }
    if (field === "id") {
      if (!value.includes("\0")) this.id = value;
    } else if (field === "event") this.event = value;
    else if (field === "data") this.data.push(value);
  }
}
