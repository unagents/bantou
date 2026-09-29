import { resolve } from "node:path";

import { expect, sentMessages, test } from "./fixtures";
import { SHOT_DIR } from "./paths";

const session = (page: import("@playwright/test").Page, name: string) =>
  page.locator(`section[aria-label="${name}"]`);

test("sessions are rows; working tasks sit right under the session, queued below", async ({ page }) => {
  await page.goto("/");
  const careery = session(page, "careery");
  await expect(careery).toBeVisible();
  const rows = careery.locator("li");
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toContainText("スキルシート xlsx 取込の列マッピング");
  await expect(rows.nth(1)).toContainText("ズーム時のレイアウト崩れ修正");
  // Sessions stack vertically (one row band each), not side by side.
  const a = await session(page, "agent-messenger").boundingBox();
  const b = await careery.boundingBox();
  expect(a!.x).toBe(b!.x);
  expect(b!.y).toBeGreaterThan(a!.y);
  await page.screenshot({ path: resolve(SHOT_DIR, "board.png"), fullPage: true });
});

test("waiting icon opens close-up modal with timeline on the right", async ({ page }) => {
  await page.goto("/");
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
  await page.getByRole("button", { name: "返答待ち" }).click();
  const dlg = page.locator('[role="dialog"]');
  await dlg.getByPlaceholder("どれにも当てはまらない場合は自由入力").fill("一旦保留、先にズーム修正");
  await dlg.getByRole("button", { name: "回答を送る" }).click();
  await expect(dlg).toContainText("回答済み: 一旦保留、先にズーム修正");
});

test("status is read-only text (no status combobox)", async ({ page }) => {
  await page.goto("/");
  const careery = session(page, "careery");
  await expect(careery).toContainText("Doing");
  await expect(page.getByRole("combobox")).toHaveCount(0);
});

test("a tag that is not a registered session is not listed", async ({ page }) => {
  await page.goto("/");
  await expect(session(page, "careery")).toBeVisible();
  await expect(session(page, "researcher")).toHaveCount(0);
});

test("add session: pick from peer list, register, protocol sent, row appears", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "セッション追加" }).click();
  const dlg = page.locator('[role="dialog"]');
  await expect(dlg.locator("tr[data-peer='webtool']")).toBeVisible();
  // self is hidden, unnamed peer is shown but not selectable
  await expect(dlg.locator("tr[data-peer='bantou-core']")).toHaveCount(0);
  await dlg.locator("tr[data-peer='webtool']").click();
  await dlg.getByRole("button", { name: /登録して規約を送る（1）/ }).click();
  await expect(session(page, "webtool")).toBeVisible();
  const sent = await sentMessages(page);
  expect(sent.map((m) => m.to)).toEqual(["p3"]);
  await page.screenshot({ path: resolve(SHOT_DIR, "session-added.png"), fullPage: true });
});

test("unnamed peer: pick, name it (defaults to cwd basename), set_name instruction sent", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "セッション追加" }).first().click();
  const dlg = page.locator('[role="dialog"]');
  await dlg.locator("tr[data-peer='p2']").click();
  const input = dlg.getByLabel("p2 のセッション名");
  await expect(input).toHaveValue("inet250");
  await input.fill("careery");
  await expect(dlg.getByRole("button", { name: /登録して規約を送る/ })).toBeDisabled();
  await input.fill("inet250");
  await dlg.getByRole("button", { name: /登録して規約を送る（1）/ }).click();
  await expect(session(page, "inet250")).toBeVisible();
  const sent = await sentMessages(page);
  expect(sent[0]!.to).toBe("p2");
  expect(sent[0]!.text).toContain("set_name「inet250」");
});

test("a session dropped from the roster disappears without a reload, other rows stay", async ({ page }) => {
  await page.goto("/");
  await expect(session(page, "careery")).toBeVisible();
  await page.evaluate(() =>
    (
      window as unknown as { __BANTOU_MOCK__: { dropAbsent: (name: string) => void } }
    ).__BANTOU_MOCK__.dropAbsent("careery"),
  );
  await expect(session(page, "careery")).toHaveCount(0);
  await expect(session(page, "agent-messenger")).toBeVisible();
  await expect(session(page, "stroke-board")).toBeVisible();
});

test("IME conversion Enter does not send; plain Enter does", async ({ page }) => {
  await page.goto("/");
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
