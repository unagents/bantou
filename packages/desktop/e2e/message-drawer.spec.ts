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

const panel = (page: Page) => page.getByTestId("message-drawer-panel");
/** Opens the drawer with a click on its strip. */
const open = async (page: Page) => {
  await handle(page).click();
  await expect(drawer(page)).toHaveAttribute("data-open", "true");
};
const shot = (page: Page, name: string) => page.screenshot({ path: `${SHOT_DIR}/${name}.png` });

test.describe("message drawer", () => {
  test.use({ seed: boardSeed });

  test("a click on the strip opens and closes it; it has no resize handle", async ({ page }) => {
    await page.goto("/");
    await pickSession(page, "stroke-board");
    await expect(drawer(page)).toHaveAttribute("data-open", "false");
    await expect(panel(page)).toBeHidden();
    await open(page);
    await expect(panel(page)).toBeVisible();
    await expect(page.getByText("最終メッセージ").first()).toBeVisible();
    // dragging the strip changes nothing
    const box = (await handle(page).boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x - 150, box.y + box.height / 2, { steps: 5 });
    await page.mouse.up();
    await expect(drawer(page)).toHaveAttribute("data-open", "true");
    await handle(page).click();
    await expect(drawer(page)).toHaveAttribute("data-open", "false");
    await open(page);
    await page.getByTestId("message-drawer-close").click();
    await expect(drawer(page)).toHaveAttribute("data-open", "false");
  });

  for (const [vw, panelW] of [
    [1300, 288],
    [1700, 384],
  ] as const) {
    test(`at ${vw}px the panel is ${panelW}px wide and the conversation narrows instead of being covered`, async ({ page }) => {
      await page.setViewportSize({ width: vw, height: 800 });
      await page.goto("/");
      await pickSession(page, "stroke-board");
      const right = page.getByTestId("right-col");
      const closedW = (await right.boundingBox())!.width;
      await shot(page, `drawer-${vw}-closed`);
      await open(page);
      const o = (await right.boundingBox())!;
      const d = (await drawer(page).boundingBox())!;
      const p = (await panel(page).boundingBox())!;
      expect(Math.round(p.width)).toBe(panelW);
      // the conversation lost exactly the panel's width and ends where the drawer starts
      expect(Math.round(closedW - o.width)).toBe(panelW);
      expect(o.x + o.width).toBeLessThanOrEqual(d.x + 0.5);
      // the terminal's own width follows (its content wraps in the narrower box)
      const term = (await page.getByTestId("terminal-pane").boundingBox())!;
      expect(term.x + term.width).toBeLessThanOrEqual(d.x + 0.5);
      // the xterm grid (input line and output) is inside the narrowed terminal: it re-wraps there instead of running under the drawer
      const grid = (await page.locator(".xterm-screen").boundingBox())!;
      expect(grid.x + grid.width).toBeLessThanOrEqual(d.x + 0.5);
      await shot(page, `drawer-${vw}-open`);
      await page.getByTestId("message-drawer-close").click();
      expect(Math.round((await right.boundingBox())!.width)).toBe(Math.round(closedW));
      console.log(`measure vw=${vw} closedW=${closedW} openW=${o.width} panelW=${p.width} termRight=${term.x + term.width} gridRight=${grid.x + grid.width} drawerX=${d.x}`);
    });
  }

  test("last messages stack up in arrival order, with the session and the time", async ({ page }) => {
    await page.goto("/");
    await pickSession(page, "stroke-board");
    await expect(items(page)).toHaveCount(0);
    await message(page, "careery", "careery の最後の応答", "2026-11-09T10:00:00.000Z");
    await message(page, "stroke-board", "stroke-board の応答\n二行目", "2026-11-09T10:01:00.000Z");
    await message(page, "careery", "careery の二つ目", "2026-11-09T10:02:00.000Z");
    await open(page);
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
    await open(page);
    await items(page).filter({ hasText: "careery の応答" }).click();
    await expect(page.locator("[aria-current=true]")).toContainText("careery");
    await expect(page.locator('section[aria-label="careery"]')).toBeVisible();
    await items(page).filter({ hasText: "agent-messenger の応答" }).click();
    await expect(page.locator("[aria-current=true]")).toContainText("agent-messenger");
    await expect(page.locator('section[aria-label="agent-messenger"]')).toBeVisible();
    // a session that is no longer on the center: the current screen stays
    await message(page, "gone-session", "消えた session の応答", "2026-11-09T10:02:00.000Z");
    await items(page).filter({ hasText: "消えた session の応答" }).click();
    await expect(page.getByText("gone-session は center に無い").first()).toBeVisible();
    await expect(page.locator("[aria-current=true]")).toContainText("agent-messenger");
    await expect(page.locator('section[aria-label="agent-messenger"]')).toBeVisible();
  });

  test("only the newest messages are kept (the oldest drop out past the cap); the newest stays in view", async ({ page }) => {
    await page.goto("/");
    await pickSession(page, "stroke-board");
    await withMock(
      page,
      (m, n) => {
        for (let i = 1; i <= n; i++) m.centerSessionMessage("careery", `応答 ${i}`, "2026-11-09T10:00:00.000Z");
      },
      501,
    );
    await open(page);
    await expect(items(page)).toHaveCount(500);
    await expect(page.getByTestId("message-drawer-text").first()).toHaveText("応答 2");
    await message(page, "careery", "応答 502", "2026-11-09T10:01:00.000Z");
    await expect(page.getByTestId("message-drawer-text").first()).toHaveText("応答 3");
    await expect(page.getByTestId("message-drawer-text").last()).toHaveText("応答 502");
    await expect(page.getByTestId("message-drawer-text").last()).toBeInViewport();
  });
});
