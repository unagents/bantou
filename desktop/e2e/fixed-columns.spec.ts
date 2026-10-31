import type { Locator, Page } from "@playwright/test";

import { expect, pickSession, test } from "./fixtures";
import { boardSeed } from "./seed";
import type { Seed } from "./mock/bantou";

/** More side-menu rows and tasks than fit in the 1280x800 viewport. */
const MANY = 60;
const names = Array.from({ length: MANY }, (_, i) => `sess-${String(i).padStart(2, "0")}`);
const tasks = Array.from({ length: MANY }, (_, i) => ({
  id: `t-many-${i}`,
  path: `/mock/demo-ws/many-${i}.md`,
  title: `たくさんのタスク ${i}`,
  status: i % 2 ? "Doing" : "Todo",
  order: i,
  tags: ["sess-00"],
  date: "2026-09-29",
  body: "",
}));
const seed: Seed = { ...boardSeed, tasks: [...boardSeed.tasks, ...tasks], sessions: names };

test.use({ seed });

const docHeights = (page: Page) =>
  page.evaluate(() => ({
    scroll: document.documentElement.scrollHeight,
    client: document.documentElement.clientHeight,
    y: window.scrollY,
  }));

const top = async (loc: Locator) => (await loc.boundingBox())!.y;

const side = (page: Page) => page.getByRole("navigation", { name: "セッション一覧" });

test("the page itself does not scroll; side menu and middle column scroll on their own", async ({ page }) => {
  await page.goto("/");
  await pickSession(page, "sess-00");
  const middle = page.getByTestId("middle-col");
  await expect(middle.getByText("たくさんのタスク 59")).toHaveCount(1);

  // the content exceeds the screen, but the document does not grow with it
  const h = await docHeights(page);
  expect(h.scroll).toBeLessThanOrEqual(h.client);
  const dims = (l: Locator) => l.evaluate((e) => ({ s: e.scrollHeight, c: e.clientHeight }));
  const sd = await dims(side(page));
  const md = await dims(middle);
  expect(sd.s).toBeGreaterThan(sd.c);
  expect(md.s).toBeGreaterThan(md.c);

  const header = page.locator("header");
  const headerTop = await top(header);
  const sideTop = await top(side(page));
  const rightTop = await top(page.getByTestId("right-col"));

  // side menu scrolls alone
  await side(page).evaluate((e) => (e.scrollTop = e.scrollHeight));
  expect(await side(page).evaluate((e) => e.scrollTop)).toBeGreaterThan(0);
  expect(await middle.evaluate((e) => e.scrollTop)).toBe(0);

  // middle column scrolls alone
  await middle.evaluate((e) => (e.scrollTop = e.scrollHeight));
  expect(await middle.evaluate((e) => e.scrollTop)).toBeGreaterThan(0);

  // nothing else moved: document, header, side menu frame, right column
  expect((await docHeights(page)).y).toBe(0);
  expect(await top(header)).toBe(headerTop);
  expect(await top(side(page))).toBe(sideTop);
  expect(await top(page.getByTestId("right-col"))).toBe(rightTop);
  const h2 = await docHeights(page);
  expect(h2.scroll).toBeLessThanOrEqual(h2.client);
});

test("wheel over the middle column scrolls only the middle column", async ({ page }) => {
  await page.goto("/");
  await pickSession(page, "sess-00");
  const middle = page.getByTestId("middle-col");
  await expect(middle.getByText("たくさんのタスク 59")).toHaveCount(1);
  const headerTop = await top(page.locator("header"));
  const sideTop = await top(side(page).locator("[data-testid=side-row]").first());

  const box = (await middle.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, 3000);
  await expect.poll(() => middle.evaluate((e) => e.scrollTop)).toBeGreaterThan(0);

  expect((await docHeights(page)).y).toBe(0);
  expect(await top(page.locator("header"))).toBe(headerTop);
  expect(await top(side(page).locator("[data-testid=side-row]").first())).toBe(sideTop);
  expect(await side(page).evaluate((e) => e.scrollTop)).toBe(0);
});
