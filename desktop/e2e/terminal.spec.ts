import { resolve } from "node:path";

import type { Page } from "@playwright/test";

import { expect, pickSession, sideRow, test } from "./fixtures";
import { SHOT_DIR } from "./paths";
import { boardSeed } from "./seed";

test.use({ seed: boardSeed });

type Mock = {
  centerRemotes: unknown[];
  outputStarts: { session: string; after: number | null }[];
  outputStops: string[];
  inputs: { session: string; data: string }[];
  resizes: { session: string; cols: number; rows: number }[];
  sessionOutput: (session: string, id: number, text: string) => void;
  sessionReset: (session: string) => void;
  sessionOutputStatus: (session: string, state: string) => void;
};

const mock = <T>(page: Page, fn: (m: Mock) => T) =>
  page.evaluate(
    (src) => new Function("m", `return (${src})(m)`)((window as unknown as { __BANTOU_MOCK__: Mock }).__BANTOU_MOCK__),
    fn.toString(),
  ) as Promise<T>;

/** The stream of `session` has been started (the view is attached and listening). */
const streaming = (page: Page, session: string) =>
  expect.poll(() => mock(page, (m) => m.outputStarts.at(-1)?.session)).toBe(session);

const send = async (page: Page, session: string, id: number, text: string) => {
  await streaming(page, session);
  await page.evaluate(
    ([s, i, t]) =>
      (window as unknown as { __BANTOU_MOCK__: Mock }).__BANTOU_MOCK__.sessionOutput(s as string, i as number, t as string),
    [session, id, text],
  );
};

const reset = async (page: Page, session: string) => {
  await streaming(page, session);
  await page.evaluate((s) => (window as unknown as { __BANTOU_MOCK__: Mock }).__BANTOU_MOCK__.sessionReset(s), session);
};

const term = (page: Page) => page.getByTestId("terminal");
const decodeInputs = (page: Page) =>
  mock(page, (m) => m.inputs.map((i) => atob(i.data)).join(""));

test("three columns: side menu | remote tasks of the session + task list | terminal", async ({ page }) => {
  await page.goto("/");
  await mock(page, (m) => {
    m.centerRemotes = [
      {
        remote_id: "r-careery-1",
        owner: "careery",
        server: "p",
        serverName: "bantou-server",
        state: "running",
        createdAt: "2026-10-29T00:59:50.000Z",
        activity: {
          at: "2026-10-29T00:59:55.000Z",
          received_ms_ago: 1000,
          stale: false,
          agents: [{ kind: "cap", id: "r-careery-1", state: "running", task: "xlsx 取込の調査", silent_ms: 2000, last_activity: "Bash 実行中" }],
        },
      },
      { remote_id: "r-other-1", owner: "stroke-board", server: "p", serverName: "bantou-server", state: "done", createdAt: "2026-10-29T00:00:00.000Z" },
    ];
  });
  await pickSession(page, "careery");

  // middle: only the selected session's remotes, the Cork task list below them
  const middle = page.getByTestId("middle-col");
  await expect(middle.getByTestId("session-remote")).toHaveCount(1);
  await expect(middle.getByTestId("session-remote")).toContainText("r-careery-1");
  await expect(middle.getByTestId("session-remote-task")).toHaveText("xlsx 取込の調査");
  await expect(middle).not.toContainText("r-other-1");
  const remotesBox = await middle.getByTestId("session-remotes").boundingBox();
  const tasksBox = await middle.locator('section[aria-label="careery"]').boundingBox();
  expect(tasksBox!.y).toBeGreaterThan(remotesBox!.y + remotesBox!.height - 2);

  // another session: its own remotes
  await pickSession(page, "stroke-board");
  await expect(middle.getByTestId("session-remote")).toHaveCount(1);
  await expect(middle.getByTestId("session-remote")).toContainText("r-other-1");
  await pickSession(page, "careery");

  // right: the terminal with the output of the session
  await send(page, "careery", 1, "claude --remote-control careery\r\n$ ");
  await expect(term(page)).toContainText("claude --remote-control careery");

  // order of the columns: side menu < middle < terminal
  const side = await page.getByRole("navigation", { name: "セッション一覧" }).boundingBox();
  const mid = await middle.boundingBox();
  const right = await page.getByTestId("terminal-pane").boundingBox();
  expect(mid!.x).toBeGreaterThanOrEqual(side!.x + side!.width - 2);
  expect(right!.x).toBeGreaterThanOrEqual(mid!.x + mid!.width - 2);

  // no "add task instruction" button any more
  await expect(page.getByRole("button", { name: /タスク追加を指示/ })).toHaveCount(0);
  await page.screenshot({ path: resolve(SHOT_DIR, "three-columns.png"), fullPage: true });
});

test("the output stream is started for the selected session and resumes after the held chunk id", async ({ page }) => {
  await page.goto("/");
  await expect.poll(() => mock(page, (m) => m.outputStarts)).toEqual([{ session: "agent-messenger", after: null }]);
  await send(page, "agent-messenger", 1, "first\r\n");
  await send(page, "agent-messenger", 2, "second\r\n");
  await expect(term(page)).toContainText("second");

  await pickSession(page, "careery");
  await expect(term(page)).not.toContainText("second");
  expect(await mock(page, (m) => m.outputStops)).toEqual(["agent-messenger"]);
  await send(page, "careery", 1, "careery output\r\n");
  await expect(term(page)).toContainText("careery output");

  // back: the buffer is repainted and the stream resumes after id 2
  await pickSession(page, "agent-messenger");
  await expect(term(page)).toContainText("second");
  await expect(term(page)).not.toContainText("careery output");
  const starts = await mock(page, (m) => m.outputStarts);
  expect(starts.at(-1)).toEqual({ session: "agent-messenger", after: 2 });
});

test("a repeated chunk id is not written twice", async ({ page }) => {
  await page.goto("/");
  await send(page, "agent-messenger", 1, "dup-line\r\n");
  await send(page, "agent-messenger", 1, "dup-line\r\n");
  await send(page, "agent-messenger", 2, "end\r\n");
  await expect(term(page)).toContainText("end");
  const text = await term(page).innerText();
  expect(text.split("dup-line").length - 1).toBe(1);
});

test("reset clears the terminal and repaints from what follows (also the held id)", async ({ page }) => {
  await page.goto("/");
  await send(page, "agent-messenger", 5, "old screen\r\n");
  await expect(term(page)).toContainText("old screen");
  await reset(page, "agent-messenger");
  await expect(term(page)).not.toContainText("old screen");
  // after a reset ids start over: id 1 is accepted again
  await send(page, "agent-messenger", 1, "new screen\r\n");
  await expect(term(page)).toContainText("new screen");
  // leaving and coming back resumes after 1, and the old screen is gone
  await pickSession(page, "careery");
  await pickSession(page, "agent-messenger");
  await expect(term(page)).toContainText("new screen");
  await expect(term(page)).not.toContainText("old screen");
  expect((await mock(page, (m) => m.outputStarts)).at(-1)).toEqual({ session: "agent-messenger", after: 1 });
});

test("keystrokes go to session_input as base64 for the shown session", async ({ page }) => {
  await page.goto("/");
  await send(page, "agent-messenger", 1, "$ ");
  await expect(term(page)).toContainText("$");
  await page.locator(".xterm-helper-textarea").focus();
  await page.keyboard.type("ls -l");
  await page.keyboard.press("Enter");
  await expect.poll(() => decodeInputs(page)).toBe("ls -l\r");
  expect((await mock(page, (m) => m.inputs)).every((i) => i.session === "agent-messenger")).toBe(true);

  await pickSession(page, "careery");
  await page.locator(".xterm-helper-textarea").focus();
  await page.keyboard.type("x");
  await expect.poll(() => mock(page, (m) => m.inputs.at(-1))).toEqual({ session: "careery", data: "eA==" });
});

test("fit and window resize go to session_resize", async ({ page }) => {
  await page.goto("/");
  await expect.poll(() => mock(page, (m) => m.resizes.length)).toBeGreaterThan(0);
  const first = (await mock(page, (m) => m.resizes)).at(-1)!;
  expect(first.session).toBe("agent-messenger");
  expect(first.cols).toBeGreaterThan(10);
  expect(first.rows).toBeGreaterThan(5);

  await page.setViewportSize({ width: 1600, height: 1000 });
  await expect.poll(() => mock(page, (m) => m.resizes.at(-1)!.cols)).toBeGreaterThan(first.cols);
  const last = (await mock(page, (m) => m.resizes)).at(-1)!;
  expect(last.rows).toBeGreaterThan(first.rows);
});

test("the stream state is shown: reconnecting", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("terminal-retrying")).toHaveCount(0);
  await page.evaluate(() =>
    (window as unknown as { __BANTOU_MOCK__: Mock }).__BANTOU_MOCK__.sessionOutputStatus("agent-messenger", "retrying"),
  );
  await expect(page.getByTestId("terminal-retrying")).toBeVisible();
  await page.evaluate(() =>
    (window as unknown as { __BANTOU_MOCK__: Mock }).__BANTOU_MOCK__.sessionOutputStatus("agent-messenger", "connected"),
  );
  await expect(page.getByTestId("terminal-retrying")).toHaveCount(0);
  await expect(sideRow(page, "agent-messenger")).toBeVisible();
});
