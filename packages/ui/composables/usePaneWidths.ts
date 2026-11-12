import type { Ref } from "vue";

/** Minimum widths (px) of the three panes: side menu | middle (remotes + tasks) | right (terminal). */
export const PANE_MIN = { side: 160, middle: 320, right: 320 } as const;
/** Widths (px) used when nothing is stored, and after a double click on a divider. */
export const PANE_DEFAULT = { side: 240, middle: 420 } as const;
/** Width (px) of one divider. */
export const PANE_DIVIDER = 6;
/** Narrowest the pane row gets: below this the row scrolls sideways instead of squeezing the panes. */
export const PANE_ROW_MIN = PANE_MIN.side + PANE_MIN.middle + PANE_MIN.right + PANE_DIVIDER * 2;
/** localStorage key. Value: `{"v":1,"side":<px>,"middle":<px>}` (the right pane takes the rest). */
export const PANE_STORAGE_KEY = "bantou.paneWidths";

type Raw = { side: number; middle: number };

const clamp = (n: number, lo: number, hi: number) => Math.min(Math.max(n, lo), Math.max(lo, hi));

/** Reads the stored widths; anything unusable falls back to the default. */
export function loadPaneWidths(storage: Pick<Storage, "getItem"> | null): Raw {
  const out: Raw = { ...PANE_DEFAULT };
  try {
    const o = JSON.parse(storage?.getItem(PANE_STORAGE_KEY) ?? "null") as Partial<Record<keyof Raw | "v", unknown>> | null;
    if (!o || o.v !== 1) return out;
    for (const k of ["side", "middle"] as const) {
      const n = o[k];
      if (typeof n === "number" && Number.isFinite(n)) out[k] = Math.round(Math.max(PANE_MIN[k], n));
    }
  } catch {
    // broken JSON or no storage: default
  }
  return out;
}

function webStorage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

/**
 * Widths of the side menu and the middle column; the right pane (terminal) takes the rest.
 * `rowWidth` is the visible width of the pane row (0 = not measured yet).
 * The stored values are kept as the user set them: a narrow window only clamps what is shown, so widening it again brings them back.
 */
export function usePaneWidths(rowWidth: Ref<number>) {
  const raw = useState<Raw>("pane-widths", () => loadPaneWidths(webStorage()));
  const avail = computed(() => Math.max(rowWidth.value, PANE_ROW_MIN) - PANE_DIVIDER * 2);

  const sideMax = computed(() => (rowWidth.value > 0 ? avail.value - PANE_MIN.middle - PANE_MIN.right : Infinity));
  const side = computed(() => Math.round(clamp(raw.value.side, PANE_MIN.side, sideMax.value)));
  const middleMax = computed(() => (rowWidth.value > 0 ? avail.value - side.value - PANE_MIN.right : Infinity));
  const middle = computed(() => Math.round(clamp(raw.value.middle, PANE_MIN.middle, middleMax.value)));

  const setSide = (w: number) => (raw.value = { ...raw.value, side: Math.round(clamp(w, PANE_MIN.side, sideMax.value)) });
  const setMiddle = (w: number) => (raw.value = { ...raw.value, middle: Math.round(clamp(w, PANE_MIN.middle, middleMax.value)) });
  const resetSide = () => setSide(PANE_DEFAULT.side);
  const resetMiddle = () => setMiddle(PANE_DEFAULT.middle);

  /** Writes the widths as the user set them (called when a drag / key press ends, not on every move). */
  function save() {
    try {
      webStorage()?.setItem(PANE_STORAGE_KEY, JSON.stringify({ v: 1, ...raw.value }));
    } catch {
      // storage full or blocked: the widths just do not survive a restart
    }
  }

  return { side, middle, sideMax, middleMax, setSide, setMiddle, resetSide, resetMiddle, save };
}
