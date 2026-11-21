import type { Page } from "@playwright/test";

import { expect, pickSession, test } from "./fixtures";
import { SHOT_DIR } from "./paths";
import { boardSeed } from "./seed";

type Mock = { centerSessionMessage: (session: string, text: string, at?: string) => void };

/** Run `fn(mock, arg)` in the page. `fn` is serialized: it must not capture anything. */
const withMock = <A>(page: Page, fn: (m: Mock, a: A) => void, arg: A) =>
  page.evaluate(
    ([src, a]) =>
      new Function("m", "a", `return (${src})(m, a)`)((window as unknown as { __BANTOU_MOCK__: Mock }).__BANTOU_MOCK__, a),
    [fn.toString(), arg] as [string, A],
  );

const message = (page: Page, session: string, text: string, at: string) =>
  withMock(page, (m, a) => m.centerSessionMessage(a.session, a.text, a.at), { session, text, at });

const drawer = (page: Page) => page.getByTestId("message-drawer");
const handle = (page: Page) => page.getByTestId("message-drawer-handle");
const items = (page: Page) => page.getByTestId("message-drawer-item");

/** Drag the handle by `dx` px (negative = left) with the mouse. */
async function drag(page: Page, dx: number) {
  const box = (await handle(page).boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx / 2, y, { steps: 4 });
  await page.mouse.move(x + dx, y, { steps: 4 });
  await page.mouse.up();
}

test.describe("message drawer", () => {
  test.use({ seed: boardSeed });

  test("pulling the right edge to the left opens it, pushing it back closes it", async ({ page }) => {
    await page.goto("/");
    await pickSession(page, "stroke-board");
    await expect(drawer(page)).toHaveAttribute("data-open", "false");
    await expect(drawer(page)).toHaveAttribute("data-visible", "0");
    await drag(page, -300);
    await expect(drawer(page)).toHaveAttribute("data-open", "true");
    await expect(drawer(page)).toHaveAttribute("data-visible", "340");
    await expect(page.getByText("最終メッセージ").first()).toBeVisible();
    // a short pull back does not close it; a long one does
    await drag(page, 60);
    await expect(drawer(page)).toHaveAttribute("data-open", "false");
    await page.screenshot({ path: `${SHOT_DIR}/drawer-closed.png` });
    await drag(page, -300);
    await expect(drawer(page)).toHaveAttribute("data-open", "true");
    await page.getByTestId("message-drawer-close").click();
    await expect(drawer(page)).toHaveAttribute("data-open", "false");
  });

  test("a half-way pull settles by which side of the middle it ends on", async ({ page }) => {
    await page.goto("/");
    await pickSession(page, "stroke-board");
    await drag(page, -100);
    await expect(drawer(page)).toHaveAttribute("data-open", "false");
    await drag(page, -250);
    await expect(drawer(page)).toHaveAttribute("data-open", "true");
  });

  test("last messages stack up in arrival order, with the session and the time", async ({ page }) => {
    await page.goto("/");
    await pickSession(page, "stroke-board");
    await expect(items(page)).toHaveCount(0);
    await message(page, "careery", "careery の最後の応答", "2026-11-09T10:00:00.000Z");
    await message(page, "stroke-board", "stroke-board の応答\n二行目", "2026-11-09T10:01:00.000Z");
    await message(page, "careery", "careery の二つ目", "2026-11-09T10:02:00.000Z");
    await drag(page, -300);
    await expect(items(page)).toHaveCount(3);
    await expect(page.getByTestId("message-drawer-session")).toHaveText(["careery", "stroke-board", "careery"]);
    await expect(page.getByTestId("message-drawer-text")).toHaveText([
      "careery の最後の応答",
      "stroke-board の応答\n二行目",
      "careery の二つ目",
    ]);
    await expect(page.getByTestId("message-drawer-time").first()).toHaveAttribute("datetime", "2026-11-09T10:00:00.000Z");
    await expect(page.getByTestId("message-drawer-time").first()).toHaveText(/\d{1,2}:\d{2}:\d{2}/);
    // a later one is appended at the end
    await message(page, "agent-messenger", "四つ目", "2026-11-09T10:03:00.000Z");
    await expect(items(page)).toHaveCount(4);
    await expect(items(page).last()).toHaveAttribute("data-session", "agent-messenger");
    await page.screenshot({ path: `${SHOT_DIR}/drawer-open.png` });
  });

  test("clicking an item moves to that session's screen", async ({ page }) => {
    await page.goto("/");
    await pickSession(page, "stroke-board");
    await message(page, "careery", "careery の応答", "2026-11-09T10:00:00.000Z");
    await message(page, "agent-messenger", "agent-messenger の応答", "2026-11-09T10:01:00.000Z");
    await drag(page, -300);
    await items(page).filter({ hasText: "careery の応答" }).click();
    await expect(page.locator("[aria-current=true]")).toContainText("careery");
    await expect(page.locator('section[aria-label="careery"]')).toBeVisible();
    await items(page).filter({ hasText: "agent-messenger の応答" }).click();
    await expect(page.locator("[aria-current=true]")).toContainText("agent-messenger");
    await expect(page.locator('section[aria-label="agent-messenger"]')).toBeVisible();
  });
});
