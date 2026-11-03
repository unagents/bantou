import type { Page } from "@playwright/test";

import { expect, pickSession, sideRow, test } from "./fixtures";
import { boardSeed } from "./seed";

type Mock = { centerSessions: Record<string, unknown>[] };

/** Run `fn(mock, arg)` in the page. `fn` is serialized: it must not capture anything. */
const withMock = <T, A = undefined>(page: Page, fn: (m: Mock, a: A) => T, arg?: A) =>
  page.evaluate(
    ([src, a]) =>
      new Function("m", "a", `return (${src})(m, a)`)(
        (window as unknown as { __BANTOU_MOCK__: Mock }).__BANTOU_MOCK__,
        a,
      ),
    [fn.toString(), arg] as [string, A | undefined],
  ) as Promise<T>;

type Usage = { usedTokens: number; windowTokens: number | null; percent: number | null; updatedAt: string };
const setUsage = (page: Page, name: string, usage: Usage | null) =>
  withMock(
    page,
    (m, a) => {
      const s = m.centerSessions.find((x) => x.name === a.name);
      if (s) s.contextUsage = a.usage;
    },
    { name, usage },
  );
/** Any click in the window re-reads the center first. */
const act = (page: Page) => page.locator("header h1").click();

const side = (page: Page, name: string) => sideRow(page, name).getByTestId("context-usage");
const header = (page: Page, name: string) => page.locator(`section[aria-label="${name}"]`).getByTestId("context-usage");

test.describe("context usage", () => {
  test.use({ seed: boardSeed });

  test("shown on the side row ('42%' only) and the selected session's header ('ctx 42% 84k/200k')", async ({ page }) => {
    await page.goto("/");
    await pickSession(page, "careery");
    await expect(side(page, "careery")).toHaveCount(0);
    await setUsage(page, "careery", { usedTokens: 84_000, windowTokens: 200_000, percent: 42, updatedAt: "2026-11-03T10:00:00.000Z" });
    await act(page);
    await expect(side(page, "careery")).toHaveText("42%");
    await expect(side(page, "careery")).toHaveAttribute("title", /84k\/200k/);
    await expect(side(page, "careery")).toHaveAttribute("data-level", "normal");
    await expect(header(page, "careery")).toHaveText("ctx 42% 84k/200k");
    await expect(header(page, "careery")).toHaveAttribute("data-level", "normal");
    // other sessions without usage show nothing
    await expect(side(page, "stroke-board")).toHaveCount(0);
  });

  test("80% and over is shown in the warning level", async ({ page }) => {
    await page.goto("/");
    await pickSession(page, "careery");
    await setUsage(page, "careery", { usedTokens: 160_000, windowTokens: 200_000, percent: 80, updatedAt: "2026-11-03T10:00:00.000Z" });
    await act(page);
    await expect(side(page, "careery")).toHaveText("80%");
    await expect(side(page, "careery")).toHaveAttribute("data-level", "warn");
    await expect(header(page, "careery")).toHaveAttribute("data-level", "warn");
    await setUsage(page, "careery", { usedTokens: 159_000, windowTokens: 200_000, percent: 79.4, updatedAt: "2026-11-03T10:01:00.000Z" });
    await act(page);
    await expect(side(page, "careery")).toHaveAttribute("data-level", "normal");
  });

  test("window unknown: side row shows nothing, header shows tokens only", async ({ page }) => {
    await page.goto("/");
    await pickSession(page, "careery");
    await setUsage(page, "careery", { usedTokens: 805_882, windowTokens: null, percent: null, updatedAt: "2026-11-03T10:00:00.000Z" });
    await act(page);
    await expect(side(page, "careery")).toHaveCount(0);
    await expect(header(page, "careery")).toHaveText("ctx 805.9k");
    await expect(header(page, "careery")).toHaveAttribute("data-level", "normal");
  });

  test("hidden again when the center sends null", async ({ page }) => {
    await page.goto("/");
    await pickSession(page, "careery");
    await setUsage(page, "careery", { usedTokens: 1000, windowTokens: 1_000_000, percent: 0.1, updatedAt: "2026-11-03T10:00:00.000Z" });
    await act(page);
    await expect(side(page, "careery")).toHaveText("0%");
    await setUsage(page, "careery", null);
    await act(page);
    await expect(side(page, "careery")).toHaveCount(0);
    await expect(header(page, "careery")).toHaveCount(0);
  });
});
