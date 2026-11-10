import type { Locator, Page } from "@playwright/test";

import { expect, pickSession, test } from "./fixtures";
import { boardSeed } from "./seed";

test.use({ seed: boardSeed });

// Keep in step with src/composables/usePaneWidths.ts
const MIN = { side: 160, middle: 320, right: 320 };
const DEFAULT = { side: 240, middle: 420 };
const KEY = "bantou.paneWidths";

type Mock = { resizes: { session: string; cols: number; rows: number }[] };
const resizes = (page: Page) =>
  page.evaluate(() => (window as unknown as { __BANTOU_MOCK__: Mock }).__BANTOU_MOCK__.resizes.map((r) => ({ ...r })));

const side = (page: Page) => page.getByRole("navigation", { name: "セッション一覧" });
const middle = (page: Page) => page.getByTestId("middle-col");
const right = (page: Page) => page.getByTestId("right-col");
const sep = (page: Page, i: 0 | 1) => page.getByRole("separator").nth(i);
const width = async (l: Locator) => Math.round((await l.boundingBox())!.width);

async function open(page: Page) {
  await page.goto("/");
  await pickSession(page, "careery");
  await expect(page.getByTestId("terminal")).toBeVisible();
}

/** Drag a divider by dx px in `steps` moves. */
async function drag(page: Page, handle: Locator, dx: number, steps = 10) {
  const b = (await handle.boundingBox())!;
  const x = b.x + b.width / 2;
  const y = b.y + b.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx, y, { steps });
  await page.mouse.up();
}

const stored = (page: Page) => page.evaluate((k) => JSON.parse(localStorage.getItem(k) ?? "null"), KEY);

test("default layout: dividers are separators with aria values", async ({ page }) => {
  await open(page);
  expect(await width(side(page))).toBe(DEFAULT.side);
  expect(await width(middle(page))).toBe(DEFAULT.middle);
  const s0 = sep(page, 0);
  await expect(s0).toHaveAttribute("aria-orientation", "vertical");
  await expect(s0).toHaveAttribute("aria-valuenow", String(DEFAULT.side));
  await expect(s0).toHaveAttribute("aria-valuemin", String(MIN.side));
  await expect(sep(page, 1)).toHaveAttribute("aria-valuenow", String(DEFAULT.middle));
  expect(await s0.evaluate((e) => getComputedStyle(e).cursor)).toBe("col-resize");
});

test("dragging a divider changes the widths of the neighbours only", async ({ page }) => {
  await open(page);
  const rightBefore = await width(right(page));

  await drag(page, sep(page, 0), 60);
  expect(await width(side(page))).toBe(DEFAULT.side + 60);
  expect(await width(middle(page))).toBe(DEFAULT.middle); // middle keeps its width, the terminal gives way
  expect(await width(right(page))).toBe(rightBefore - 60);

  await drag(page, sep(page, 1), -50);
  expect(await width(middle(page))).toBe(DEFAULT.middle - 50);
  expect(await width(side(page))).toBe(DEFAULT.side + 60);
  expect(await width(right(page))).toBe(rightBefore - 60 + 50);
});

test("a drag does not select text, and the divider shows itself while dragging", async ({ page }) => {
  await open(page);
  const h = sep(page, 1);
  const b = (await h.boundingBox())!;
  await page.mouse.move(b.x + b.width / 2, b.y + 100);
  await page.mouse.down();
  await page.mouse.move(b.x + 40, b.y + 100, { steps: 5 });
  await expect(h).toHaveAttribute("data-dragging", "true");
  expect(await page.evaluate(() => document.documentElement.classList.contains("pane-resizing"))).toBe(true);
  await page.mouse.move(b.x + 80, b.y + 300, { steps: 5 });
  await page.mouse.up();
  expect(await page.evaluate(() => String(getSelection()))).toBe("");
  await expect(h).not.toHaveAttribute("data-dragging", "true");
  expect(await page.evaluate(() => document.documentElement.classList.contains("pane-resizing"))).toBe(false);
});

test("a drag that leaves the window or crosses the terminal keeps following the pointer", async ({ page }) => {
  await open(page);
  const h = sep(page, 1);
  const b = (await h.boundingBox())!;
  const y = b.y + 200;
  await page.mouse.move(b.x + 3, y);
  await page.mouse.down();
  // over the terminal, then far outside the window on the right, then back
  await page.mouse.move(b.x + 300, y, { steps: 5 });
  await page.mouse.move(2000, y, { steps: 5 });
  await page.mouse.move(b.x + 3 + 30, y, { steps: 5 });
  await page.mouse.up();
  expect(await width(middle(page))).toBe(DEFAULT.middle + 30);
});

test("widths never go below the minimum", async ({ page }) => {
  await open(page);
  await drag(page, sep(page, 0), -1000);
  expect(await width(side(page))).toBe(MIN.side);
  await drag(page, sep(page, 1), -2000);
  expect(await width(middle(page))).toBe(MIN.middle);
  // push both to the right: the terminal keeps its minimum
  await drag(page, sep(page, 1), 3000);
  expect(await width(right(page))).toBe(MIN.right);
  await drag(page, sep(page, 0), 3000);
  expect(await width(right(page))).toBe(MIN.right);
  expect(await width(middle(page))).toBeGreaterThanOrEqual(MIN.middle);
  expect(await width(side(page))).toBeGreaterThanOrEqual(MIN.side);
});

test("a narrow window keeps the minimums (the row scrolls sideways) and the stored widths come back when widened", async ({ page }) => {
  await open(page);
  await drag(page, sep(page, 0), 100);
  await drag(page, sep(page, 1), 100);
  await page.setViewportSize({ width: 700, height: 800 });
  await expect.poll(() => width(right(page))).toBeGreaterThanOrEqual(MIN.right);
  expect(await width(side(page))).toBeGreaterThanOrEqual(MIN.side);
  expect(await width(middle(page))).toBeGreaterThanOrEqual(MIN.middle);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await page.setViewportSize({ width: 1280, height: 800 });
  await expect.poll(() => width(side(page))).toBe(DEFAULT.side + 100);
  expect(await width(middle(page))).toBe(DEFAULT.middle + 100);
});

test("widths are saved and restored after a reload", async ({ page }) => {
  await open(page);
  await drag(page, sep(page, 0), 40);
  await drag(page, sep(page, 1), 70);
  expect(await stored(page)).toEqual({ v: 1, side: DEFAULT.side + 40, middle: DEFAULT.middle + 70 });
  await page.reload();
  await pickSession(page, "careery");
  expect(await width(side(page))).toBe(DEFAULT.side + 40);
  expect(await width(middle(page))).toBe(DEFAULT.middle + 70);
});

test("broken stored data falls back to the default", async ({ page }) => {
  await page.addInitScript((k) => localStorage.setItem(k, '{"v":1,"side":"x","middle":null}'), KEY);
  await open(page);
  expect(await width(side(page))).toBe(DEFAULT.side);
  expect(await width(middle(page))).toBe(DEFAULT.middle);
});

test("double click resets a divider to the default and saves it", async ({ page }) => {
  await open(page);
  await drag(page, sep(page, 0), 80);
  await sep(page, 0).dblclick();
  expect(await width(side(page))).toBe(DEFAULT.side);
  expect((await stored(page)).side).toBe(DEFAULT.side);
});

test("keyboard: arrows, shift, Home, End on a focused divider", async ({ page }) => {
  await open(page);
  const s0 = sep(page, 0);
  await s0.focus();
  await page.keyboard.press("ArrowRight");
  expect(await width(side(page))).toBe(DEFAULT.side + 16);
  await expect(s0).toHaveAttribute("aria-valuenow", String(DEFAULT.side + 16));
  await page.keyboard.press("Shift+ArrowLeft");
  expect(await width(side(page))).toBe(DEFAULT.side + 16 - 64);
  await page.keyboard.press("Home");
  expect(await width(side(page))).toBe(MIN.side);
  await page.keyboard.press("End");
  expect(await width(right(page))).toBe(MIN.right);
  expect((await stored(page)).side).toBe(await width(side(page)));

  // the divider on the terminal side: ArrowLeft narrows the middle column (End above squeezed it to the minimum: make room first)
  await page.keyboard.press("Home");
  const s1 = sep(page, 1);
  await s1.focus();
  const m = await width(middle(page));
  await page.keyboard.press("ArrowLeft");
  expect(await width(middle(page))).toBe(m - 16);
});

test("terminal follows the width: fit runs and one resize reaches the center, not one per pointer move", async ({ page }) => {
  await open(page);
  await expect.poll(async () => (await resizes(page)).length).toBeGreaterThan(0);
  const before = await resizes(page);
  const last0 = before.at(-1)!;
  const n0 = before.length;

  // 60 moves, 200px narrower terminal
  await drag(page, sep(page, 1), 200, 60);
  await expect.poll(async () => (await resizes(page)).at(-1)!.cols).toBeLessThan(last0.cols);
  const after = await resizes(page);
  expect(after.at(-1)!.session).toBe("careery");
  expect(after.length - n0).toBeLessThan(15); // debounced (100 ms), far fewer than the 60 moves

  // and back: wider again
  const narrow = after.at(-1)!.cols;
  await drag(page, sep(page, 1), -200, 60);
  await expect.poll(async () => (await resizes(page)).at(-1)!.cols).toBeGreaterThan(narrow);
});
