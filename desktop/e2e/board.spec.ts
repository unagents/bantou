import { resolve } from "node:path";

import { expect, pickSession, sentMessages, sideRow, test } from "./fixtures";
import { SHOT_DIR } from "./paths";
import { boardSeed } from "./seed";

test.use({ seed: boardSeed });

const session = (page: import("@playwright/test").Page, name: string) =>
  page.locator(`section[aria-label="${name}"]`);

test("side menu lists the sessions; the right pane shows only the selected one", async ({ page }) => {
  await page.goto("/");
  const rows = page.getByTestId("side-row");
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(0)).toContainText("agent-messenger");
  await expect(rows.nth(0)).toContainText("1 / 0");
  // Nothing selected yet: the first one is shown.
  await expect(session(page, "agent-messenger")).toBeVisible();
  await expect(page.locator("section[aria-label]")).toHaveCount(1);
  await pickSession(page, "careery");
  await expect(page.locator("section[aria-label]")).toHaveCount(1);
  await expect(sideRow(page, "careery")).toContainText("1 / 1");
  const careery = session(page, "careery");
  const taskRows = careery.locator("li");
  await expect(taskRows).toHaveCount(2);
  await expect(taskRows.nth(0)).toContainText("スキルシート xlsx 取込の列マッピング");
  await expect(taskRows.nth(1)).toContainText("ズーム時のレイアウト崩れ修正");
  // The side menu is on the left, the selected session on the right.
  const side = await page.getByRole("navigation", { name: "セッション一覧" }).boundingBox();
  const main = await careery.boundingBox();
  expect(main!.x).toBeGreaterThanOrEqual(side!.x + side!.width - 2);
  await page.screenshot({ path: resolve(SHOT_DIR, "board.png"), fullPage: true });
});

test("the selection is not kept across a reload (first session again)", async ({ page }) => {
  await page.goto("/");
  await pickSession(page, "careery");
  await page.reload();
  await expect(session(page, "agent-messenger")).toBeVisible();
  await expect(session(page, "careery")).toHaveCount(0);
});

test("waiting icon opens close-up modal with timeline on the right", async ({ page }) => {
  await page.goto("/");
  await pickSession(page, "careery");
  await page.getByRole("button", { name: "返答待ち" }).click();
  const dlg = page.locator('[role="dialog"]');
  await expect(dlg).toContainText("スキルシート xlsx 取込の列マッピング");
  const timeline = dlg.getByTestId("timeline");
  await expect(timeline).toContainText("取込時の扱いを決めてほしい");
  // bantou supplement is added on open when none exists yet.
  await expect(timeline).toContainText("補足: 判断材料のモック。");
  const left = await dlg.locator("aside").boundingBox();
  const right = await timeline.boundingBox();
  expect(right!.x).toBeGreaterThan(left!.x + left!.width - 2);
  await page.screenshot({ path: resolve(SHOT_DIR, "modal.png") });
});

test("chat with bantou, then answer with an option → relayed to the session", async ({ page }) => {
  await page.goto("/");
  await pickSession(page, "careery");
  await page.getByRole("button", { name: "返答待ち" }).click();
  const dlg = page.locator('[role="dialog"]');
  await dlg.getByPlaceholder("bantou に質問・相談").fill("どれが無難？");
  await dlg.getByPlaceholder("bantou に質問・相談").press("Enter");
  await expect(dlg.getByTestId("timeline")).toContainText("「どれが無難？」への回答（モック）");
  await dlg.getByRole("button", { name: /両形式をパースする/ }).click();
  await dlg.getByRole("button", { name: "回答を送る" }).click();
  await expect(dlg).toContainText("回答済み: 両形式をパースする");
  const sent = await sentMessages(page);
  expect(sent).toHaveLength(1);
  expect(sent[0]!.to).toBe("careery");
  expect(sent[0]!.text).toContain("両形式をパースする");
  expect(sent[0]!.text).toContain("回答どおり進めよ");
  await page.screenshot({ path: resolve(SHOT_DIR, "answered.png") });
});

test("free-text answer when no option fits", async ({ page }) => {
  await page.goto("/");
  await pickSession(page, "careery");
  await page.getByRole("button", { name: "返答待ち" }).click();
  const dlg = page.locator('[role="dialog"]');
  await dlg.getByPlaceholder("どれにも当てはまらない場合は自由入力").fill("一旦保留、先にズーム修正");
  await dlg.getByRole("button", { name: "回答を送る" }).click();
  await expect(dlg).toContainText("回答済み: 一旦保留、先にズーム修正");
});

test("status is read-only text (no status combobox)", async ({ page }) => {
  await page.goto("/");
  await pickSession(page, "careery");
  const careery = session(page, "careery");
  await expect(careery).toContainText("Doing");
  await expect(page.getByRole("combobox")).toHaveCount(0);
});

test("a tag that is not an added session is not listed", async ({ page }) => {
  await page.goto("/");
  await pickSession(page, "careery");
  await expect(session(page, "researcher")).toHaveCount(0);
});

test("IME conversion Enter does not send; plain Enter does", async ({ page }) => {
  await page.goto("/");
  await pickSession(page, "careery");
  await page.getByRole("button", { name: "返答待ち" }).click();
  const dlg = page.locator('[role="dialog"]');
  const input = dlg.getByPlaceholder("bantou に質問・相談");
  const timeline = dlg.getByTestId("timeline");
  await input.fill("へんかんちゅう");
  await input.dispatchEvent("keydown", { key: "Enter", keyCode: 229 });
  await input.dispatchEvent("keydown", { key: "Enter", isComposing: true });
  await expect(input).toHaveValue("へんかんちゅう");
  await expect(timeline).not.toContainText("へんかんちゅう");
  await input.press("Enter");
  await expect(timeline).toContainText("へんかんちゅう");
});
