import { expect, sentMessages, test } from "./fixtures";

test("header has no standalone task button", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("header").getByRole("button", { name: "タスク", exact: true })).toHaveCount(0);
});

test("session header button sends an add-task instruction to that session", async ({ page }) => {
  await page.goto("/");
  const btn = page.getByRole("button", { name: "stroke-board にタスク追加を指示" });
  await expect(btn).toContainText("タスク追加");
  await btn.click();
  const dlg = page.locator('[role="dialog"]');
  await expect(dlg).toContainText("stroke-board にタスク追加を指示");
  const send = dlg.getByRole("button", { name: "指示を送信" });
  await expect(send).toBeDisabled();
  await dlg.getByLabel("タスク名").fill("凡例の色を修正");
  await dlg.getByLabel("作業内容").fill("凡例の色をテーマに合わせる");
  await send.click();
  await expect(dlg).toBeHidden();
  await expect(page.getByText("stroke-board にタスク追加を指示").first()).toBeVisible();
  const sent = await sentMessages(page);
  expect(sent).toEqual([
    {
      to: "stroke-board",
      text: "【bantou タスク追加指示】\nタスク名: 凡例の色を修正\n作業内容:\n凡例の色をテーマに合わせる",
    },
  ]);
});
