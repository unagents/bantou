import { expect, test } from "./fixtures";
import { defaultSeed } from "./seed";

const calls = (page: import("@playwright/test").Page) =>
  page.evaluate(
    () =>
      (window as unknown as { __BANTOU_MOCK__: { calls: { cmd: string }[] } }).__BANTOU_MOCK__.calls.map(
        (c) => c.cmd,
      ),
  );

test.describe("no update", () => {
  test("idle -> check -> latest -> back to idle; the launch auto check is silent", async ({ page }) => {
    await page.goto("/");
    const control = page.getByTestId("updater-control");
    await expect(control).toHaveText("アップデートを確認");
    await expect.poll(() => calls(page)).toContain("plugin:updater|check");
    await control.click();
    await expect(control).toHaveText("最新");
    await expect(control).toHaveText("アップデートを確認");
  });
});

test.describe("update available", () => {
  test.use({ seed: { ...defaultSeed, update: { version: "9.9.9" } } });

  test("the launch check switches the header button; click downloads and restarts", async ({ page }) => {
    await page.goto("/");
    const control = page.getByTestId("updater-control");
    await expect(control).toHaveText("アップデートして再起動（v9.9.9）");
    expect(await calls(page)).toContain("plugin:updater|check");
    await expect(page.getByText("が利用可能")).toHaveCount(0);

    await control.click();
    await expect.poll(() => calls(page)).toEqual(
      expect.arrayContaining(["plugin:updater|download_and_install", "plugin:process|restart"]),
    );
  });
});

// Auto-check retry / periodic re-check. page.clock fast-forwards the page's timers (runFor would
// run every other interval of the app for the whole span); the mock records every
// `plugin:updater|check` in `calls`.
type MockPage = import("@playwright/test").Page;
const checks = async (page: MockPage) => (await calls(page)).filter((c) => c === "plugin:updater|check").length;
const MIN = 60_000;
const HOUR = 60 * MIN;

/** Let the page finish the check in flight (it arms the next timer when it settles). */
const settle = (page: MockPage) => page.waitForTimeout(300);

/** Stop the page clock from ticking in real time, so only fastForward moves it. */
async function freeze(page: MockPage) {
  await settle(page);
  const now = await page.evaluate(() => Date.now());
  await page.clock.pauseAt(now + 100);
}

/** Before `delay` (minus 5 s: the first timer was armed a moment before the clock froze) nothing runs; after it exactly one more check does. */
async function expectNextCheckAfter(page: MockPage, delay: number) {
  await settle(page);
  const n = await checks(page);
  await page.clock.fastForward(delay - 5_000);
  await settle(page);
  expect(await checks(page)).toBe(n);
  await page.clock.fastForward(10_000);
  await expect.poll(() => checks(page)).toBe(n + 1);
}

// Unmounts the Vue app (runs onBeforeUnmount of every composable).
const unmountApp = (page: MockPage) =>
  page.evaluate(() =>
    (document.querySelector("#__nuxt") as unknown as { __vue_app__: { unmount(): void } }).__vue_app__.unmount(),
  );

test.describe("auto check retry", () => {
  test.use({ seed: { ...defaultSeed, updateCheckFailures: 4 } });

  test("a failed launch check retries with backoff 1 -> 5 -> 30 min (capped at 30), then waits 6 h once up to date", async ({
    page,
  }) => {
    await page.clock.install();
    await page.goto("/");
    const control = page.getByTestId("updater-control");
    await expect.poll(() => checks(page)).toBe(1); // launch check failed
    await expect(control).toHaveText("アップデートを確認");
    await freeze(page);

    await expectNextCheckAfter(page, 1 * MIN); // check 2 fails
    await expectNextCheckAfter(page, 5 * MIN); // check 3 fails
    await expectNextCheckAfter(page, 30 * MIN); // check 4 fails (last seeded failure)
    await expectNextCheckAfter(page, 30 * MIN); // capped at 30 min; check 5 succeeds
    await expectNextCheckAfter(page, 6 * HOUR); // up to date: the next one is 6 h away
    await expect(control).toHaveText("アップデートを確認");
  });
});

test.describe("auto check periodic", () => {
  test("idle and up to date: re-checks every 6 h, one check per period", async ({ page }) => {
    await page.clock.install();
    await page.goto("/");
    await expect.poll(() => checks(page)).toBe(1);
    await freeze(page);
    await expectNextCheckAfter(page, 6 * HOUR);
    await expectNextCheckAfter(page, 6 * HOUR);
    await expectNextCheckAfter(page, 6 * HOUR);
  });

  test("a manual up-to-date check restarts the 6 h period (one timer only)", async ({ page }) => {
    await page.clock.install();
    await page.goto("/");
    await expect.poll(() => checks(page)).toBe(1);
    await freeze(page);
    await page.clock.fastForward(5 * HOUR);
    await page.getByTestId("updater-control").click(); // manual at 5 h
    await expect.poll(() => checks(page)).toBe(2);
    // The old timer (due at 6 h) was replaced: the next check is 6 h after the manual one.
    await expectNextCheckAfter(page, 6 * HOUR);
  });

  test("unmount stops the timer", async ({ page }) => {
    await page.clock.install();
    await page.goto("/");
    await expect.poll(() => checks(page)).toBe(1);
    await settle(page);
    await unmountApp(page);
    await page.clock.fastForward(7 * HOUR);
    await settle(page);
    expect(await checks(page)).toBe(1);
  });
});

test.describe("auto check stays off when not idle", () => {
  test.use({ seed: { ...defaultSeed, update: { version: "9.9.9" } } });

  test("available: no further auto checks", async ({ page }) => {
    await page.clock.install();
    await page.goto("/");
    const control = page.getByTestId("updater-control");
    await expect(control).toHaveText("アップデートして再起動（v9.9.9）");
    await settle(page);
    expect(await checks(page)).toBe(1);
    await page.clock.fastForward(7 * HOUR);
    await settle(page);
    expect(await checks(page)).toBe(1);
    await expect(control).toHaveText("アップデートして再起動（v9.9.9）");
  });
});

test.describe("auto check stays off after a manual error", () => {
  test.use({ seed: { ...defaultSeed, updateCheckFailures: 2 } });

  test("manual check error: no auto retry until the user acts", async ({ page }) => {
    await page.clock.install();
    await page.goto("/");
    const control = page.getByTestId("updater-control");
    await expect.poll(() => checks(page)).toBe(1); // auto check failed (1 failure left); retry armed at 1 min
    await settle(page);
    await control.click(); // manual check fails too -> error state, replaces the pending auto timer
    await expect(control).toHaveAttribute("data-updater-state", "error");
    expect(await checks(page)).toBe(2);
    await page.clock.fastForward(7 * HOUR);
    await settle(page);
    expect(await checks(page)).toBe(2);
    await expect(control).toHaveAttribute("data-updater-state", "error");
  });
});

test.describe("no folder selected", () => {
  test.use({ seed: { ...defaultSeed, dir: null, update: { version: "9.9.9" } } });

  test("the update control is in the header without a folder", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("button", { name: "フォルダを開く" })).toBeVisible();
    await expect(page.getByTestId("updater-control")).toHaveText("アップデートして再起動（v9.9.9）");
  });
});
