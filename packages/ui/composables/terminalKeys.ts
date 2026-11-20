// Pure part of the terminal key handling (no Nuxt / Tauri / xterm imports, so a node spec can import it).
// The table lives here so that every sender of terminal input (the xterm screen now, an input box and
// the web's special-key row later) maps keys to the same bytes.

/** ESC CR: what terminals send for shift+enter; TUIs such as claude read it as "newline, do not submit". */
export const SHIFT_ENTER_BYTES = "\x1b\r";

/** The fields of a KeyboardEvent this table reads (a KeyboardEvent fits as is). */
export interface KeyLike {
  key: string;
  shiftKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  isComposing?: boolean;
  keyCode?: number;
}

/**
 * The bytes to send to the pty instead of what xterm would send, or `null` when xterm's own handling stays.
 * Only shift+enter (no other modifier) is mapped. Enter during IME composition (isComposing / keyCode 229 /
 * between compositionstart and compositionend, given as `composing`) is never mapped: it confirms the text.
 */
export function terminalKeyBytes(ev: KeyLike, composing = false): string | null {
  if (composing || ev.isComposing || ev.keyCode === 229) return null;
  if (ev.key === "Enter" && ev.shiftKey && !ev.ctrlKey && !ev.altKey && !ev.metaKey) return SHIFT_ENTER_BYTES;
  return null;
}
