import type { Page } from "@playwright/test";

import { expect, test } from "./fixtures";
import { defaultSeed } from "./seed";

/** The open tooltip (reka renders it in a portal). */
const tip = (page: Page) => page.locator("[data-reka-popper-content-wrapper]");

test.describe("EHOSTUNREACH on the broker", () => {
  test.use({
    seed: {
      ...defaultSeed,
      broker: {
        connected: false,
        peer_id: null,
        error:
          "error sending request for url (http://192.168.1.10:7901/register): tcp connect error: No route to host (os error 65) [EHOSTUNREACH]",
      },
    },
  });

  test("the messenger tooltip asks to check the Local Network permission", async ({ page }) => {
    await page.goto("/");
    await page.getByTestId("messenger-status").hover();
    await expect(tip(page)).toContainText("ローカルネットワークの許可を確認");
    await expect(tip(page)).toContainText("os error 65");
  });
});

test.describe("other broker errors", () => {
  test.use({
    seed: { ...defaultSeed, broker: { connected: false, peer_id: null, error: "Connection refused (os error 61)" } },
  });

  test("the tooltip shows the error without the permission hint", async ({ page }) => {
    await page.goto("/");
    await page.getByTestId("messenger-status").hover();
    await expect(tip(page)).toContainText("Connection refused");
    await expect(tip(page)).not.toContainText("ローカルネットワーク");
  });
});
