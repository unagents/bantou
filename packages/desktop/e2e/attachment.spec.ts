import type { Page } from "@playwright/test";

import { expect, pickSession, test } from "./fixtures";
import { boardSeed } from "./seed";

test.use({ seed: boardSeed });

type Mock = {
  inputs: { session: string; data: string }[];
  attachCalls: { cmd: string; session: string; paths?: string[]; bytes?: number }[];
  pickFiles: string[];
  fileDrop: (paths: string[], x: number, y: number) => void;
  outputStarts: { session: string }[];
};

const mock = <T>(page: Page, fn: (m: Mock) => T) =>
  page.evaluate(
    (src) => new Function("m", `return (${src})(m)`)((window as unknown as { __BANTOU_MOCK__: Mock }).__BANTOU_MOCK__),
    fn.toString(),
  ) as Promise<T>;

const typed = (page: Page) => mock(page, (m) => m.inputs.map((i) => atob(i.data)).join("|"));

/** Drop `paths` over the middle of the terminal pane (physical px = css px × devicePixelRatio). */
async function dropOn(page: Page, paths: string[], inside = true) {
  const box = (await page.getByTestId("terminal-pane").boundingBox())!;
  const x = inside ? box.x + box.width / 2 : 5;
  const y = inside ? box.y + box.height / 2 : 5;
  const dpr = await page.evaluate(() => window.devicePixelRatio);
  await page.evaluate(([p, px, py]) => (window as unknown as { __BANTOU_MOCK__: Mock }).__BANTOU_MOCK__.fileDrop(p as string[], px as number, py as number), [
    paths,
    x * dpr,
    y * dpr,
  ]);
}

const ready = async (page: Page) => {
  await page.goto("/");
  await expect.poll(() => mock(page, (m) => m.outputStarts.at(-1)?.session)).toBe("agent-messenger");
};

test("drop: image files over the terminal type their paths (space-separated, no Enter)", async ({ page }) => {
  await ready(page);
  await dropOn(page, ["/Users/me/a.png", "/Users/me/b.JPG"]);
  await expect.poll(() => typed(page)).toBe(
    " /ws/agent-messenger/attachments/20261104-024500-01.png /ws/agent-messenger/attachments/20261104-024500-02.jpg ",
  );
  expect((await typed(page)).includes("\r")).toBe(false);
  await expect(page.getByTestId("terminal-error")).toHaveCount(0);
});

test("drop: a wrong type or a too big file shows the reason and types nothing", async ({ page }) => {
  await ready(page);
  await dropOn(page, ["/Users/me/note.txt"]);
  await expect(page.getByTestId("terminal-error")).toContainText("画像の型が違う");
  await dropOn(page, ["/Users/me/big.png"]);
  await expect(page.getByTestId("terminal-error")).toContainText("20MB を超えている");
  expect(await typed(page)).toBe("");
});

test("drop: released outside the terminal pane is ignored", async ({ page }) => {
  await ready(page);
  await dropOn(page, ["/Users/me/a.png"], false);
  await page.waitForTimeout(300);
  expect(await mock(page, (m) => m.attachCalls.length)).toBe(0);
});

test("drop: the shown session is the target", async ({ page }) => {
  await ready(page);
  await pickSession(page, "careery");
  await expect.poll(() => mock(page, (m) => m.outputStarts.at(-1)?.session)).toBe("careery");
  await dropOn(page, ["/Users/me/a.gif"]);
  await expect.poll(() => typed(page)).toBe(" /ws/careery/attachments/20261104-024500-01.gif ");
  expect((await mock(page, (m) => m.attachCalls.at(-1)))!.session).toBe("careery");
});

test("attach button: the dialog's files (several) type their paths; cancel does nothing", async ({ page }) => {
  await ready(page);
  await page.getByTestId("terminal-attach").click();
  await expect.poll(() => mock(page, (m) => m.attachCalls.length)).toBe(1);
  expect(await typed(page)).toBe("");
  await mock(page, (m) => void (m.pickFiles = ["/x/1.png", "/x/2.webp", "/x/doc.pdf"]));
  await page.getByTestId("terminal-attach").click();
  await expect.poll(() => typed(page)).toBe(
    " /ws/agent-messenger/attachments/20261104-024500-01.png /ws/agent-messenger/attachments/20261104-024500-02.webp ",
  );
  // the pdf is refused with a reason, the others still went in
  await expect(page.getByTestId("terminal-error")).toContainText("doc.pdf: 画像の型が違う");
});

/** A synthetic paste event, as the browser fires it for Cmd/Ctrl+V. */
const paste = (page: Page, items: { text?: string; file?: { name: string; type: string; bytes: number[] } }) =>
  page.evaluate((it) => {
    const dt = new DataTransfer();
    if (it.text) dt.setData("text/plain", it.text);
    if (it.file) dt.items.add(new File([new Uint8Array(it.file.bytes)], it.file.name, { type: it.file.type }));
    const target = document.querySelector(".xterm-helper-textarea")!;
    target.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
  }, items);

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3];

test("paste: an image on the clipboard goes as bytes and its path is typed", async ({ page }) => {
  await ready(page);
  await paste(page, { file: { name: "image.png", type: "image/png", bytes: PNG } });
  await expect.poll(() => typed(page)).toBe(" /ws/agent-messenger/attachments/20261104-024500-01.png ");
  expect(await mock(page, (m) => m.attachCalls.at(-1))).toEqual({ cmd: "session_attach_bytes", session: "agent-messenger", bytes: PNG.length });
});

test("paste: text on the clipboard is pasted as before (no attachment)", async ({ page }) => {
  await ready(page);
  await paste(page, { text: "hello" });
  await expect.poll(() => typed(page)).toBe("hello");
  expect(await mock(page, (m) => m.attachCalls.length)).toBe(0);
});

test("paste: a wrong image type is refused in the view with a reason", async ({ page }) => {
  await ready(page);
  await paste(page, { file: { name: "a.bmp", type: "image/bmp", bytes: [1, 2, 3] } });
  await expect(page.getByTestId("terminal-error")).toContainText("画像の型が違う");
  expect(await mock(page, (m) => m.attachCalls.length)).toBe(0);
});
