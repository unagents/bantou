import { expect, test } from "./fixtures";

test.describe("message drawer (phone)", () => {
  test("a session's last message comes through the event stream; tapping it opens that session's page", async ({ page, stack }) => {
    stack.setSessions(["alpha", "beta"]);
    await page.goto("/");
    await expect(page.getByTestId("side-row")).toHaveCount(2);
    // the stream must be up before the event is sent: wait for the backend to hold the center's /events open
    await expect.poll(() => stack.center.gets).toBeGreaterThan(0);
    await stack.pushSessionMessage("beta", "beta の最後の応答", "2026-11-09T10:00:00.000Z");
    await stack.pushSessionMessage("alpha", "alpha の最後の応答", "2026-11-09T10:01:00.000Z");
    const drawer = page.getByTestId("message-drawer");
    await expect(drawer).toHaveAttribute("data-open", "false");
    // nothing of the page sits under the closed drawer's strip
    const strip = (await page.getByTestId("message-drawer-handle").boundingBox())!;
    const row = (await page.getByTestId("side-row").first().boundingBox())!;
    expect(row.x + row.width).toBeLessThanOrEqual(strip.x + 0.5);
    await page.getByTestId("message-drawer-handle").click();
    await expect(drawer).toHaveAttribute("data-open", "true");
    await expect(page.getByTestId("message-drawer-session")).toHaveText(["beta", "alpha"]);
    await page.getByTestId("message-drawer-item").filter({ hasText: "beta の最後の応答" }).click();
    await expect(page).toHaveURL(/\/s\/beta$/);
    await expect(page.getByTestId("terminal-page")).toBeVisible();
    // the list survives the page change
    await expect(page.getByTestId("message-drawer-item")).toHaveCount(2);
  });
});
