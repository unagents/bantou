// Pure part of the key-triggered session list refresh (no Nuxt / Tauri imports, so a node spec can import it).

/** Typing must not ask the center for the list on every key: at most one key-triggered read per this long. */
export const KEY_REFRESH_MIN_MS = 5000;

/**
 * Leading-edge gate: `pass()` is true for the first call and then again only once `minMs` has passed since the
 * last true. The first key after a pause still refreshes the list (as before); a burst of keys refreshes once.
 */
export function createRefreshGate(minMs: number, now: () => number = Date.now): { pass(): boolean } {
  let last = -Infinity;
  return {
    pass() {
      const t = now();
      if (t - last < minMs) return false;
      last = t;
      return true;
    },
  };
}
