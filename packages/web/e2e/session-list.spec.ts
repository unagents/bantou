import { expect, test } from "./fixtures";

test.describe("session list (phone, level 1)", () => {
  test("shows the center's sessions", async ({ page, stack }) => {
    stack.setSessions(["alpha", "beta"]);
    await page.goto("/");
    await expect(page.getByTestId("side-row")).toHaveCount(2);
    await expect(page.getByTestId("side-row").first()).toContainText("alpha");
    await expect(page.getByTestId("side-row").nth(1)).toContainText("beta");
  });

  test("a change on the center shows up through the event stream", async ({ page, stack }) => {
    stack.setSessions(["alpha"]);
    await page.goto("/");
    await expect(page.getByTestId("side-row")).toHaveCount(1);
    // the stream must be up before the event is sent: wait for the backend to hold the center's /events open
    await expect.poll(() => stack.center.gets).toBeGreaterThan(0);
    stack.setSessions(["alpha", "gamma"]);
    await stack.pushSessionsEvent("created", "gamma");
    await expect(page.getByTestId("side-row")).toHaveCount(2);
    await expect(page.locator('[data-testid="side-row"][data-name="gamma"]')).toBeVisible();
  });

  test("an empty center says so", async ({ page, stack }) => {
    stack.setSessions([]);
    await page.goto("/");
    await expect(page.getByTestId("no-sessions")).toBeVisible();
  });
});

test.describe("guard and target", () => {
  test("without the shared key / JWT nothing is served (page and assets)", async ({ stack, browser }) => {
    const ctx = await browser.newContext({ extraHTTPHeaders: {} }); // no Cloudflare headers
    const page = await ctx.newPage();
    const res = await page.goto(stack.base + "/");
    expect(res?.status()).toBe(403);
    expect(await page.content()).not.toContain("_nuxt");
    const noJwt = await ctx.request.get(stack.base + "/api/me", { headers: { "x-bantou-proxy-key": stack.headers["x-bantou-proxy-key"]! } });
    expect(noJwt.status()).toBe(401);
    await ctx.close();
  });

  test("no target: says so", async ({ page, stack }) => {
    stack.setTarget(false);
    try {
      await page.goto("/");
      await expect(page.getByTestId("no-target")).toBeVisible();
    } finally {
      stack.setTarget(true);
    }
  });
});

test.describe("Access session expiry (design 5.2)", () => {
  // The first event stream ends by itself (a dropped connection); the browser reconnects after `retry` ms.
  const DROPPED = { status: 200, contentType: "text/event-stream", body: "retry: 200\n: hi\n\n" } as const;

  test("reloads when the stream cannot come back and /api/me no longer answers as the backend", async ({ page, stack }) => {
    stack.setSessions(["alpha"]);
    // Cloudflare after the Access session is gone: a redirect to the login page for the stream, the login page (HTML 200) for /api/me
    let streams = 0;
    await page.route("**/api/events", (route) =>
      ++streams === 1 ? route.fulfill(DROPPED) : route.fulfill({ status: 302, headers: { location: "/cdn-cgi/access/login" } }),
    );
    await page.route("**/cdn-cgi/access/login", (route) => route.fulfill({ status: 200, contentType: "text/html", body: "<html>login</html>" }));
    let meAsked = 0;
    await page.route("**/api/me", (route) => {
      meAsked++;
      return route.fulfill({ status: 200, contentType: "text/html", body: "<html>login</html>" });
    });
    let loads = 0;
    page.on("load", () => loads++);
    await page.goto("/");
    // the page was loaded once; the reload is a second load
    await expect.poll(() => loads, { timeout: 20_000 }).toBeGreaterThanOrEqual(2);
    expect(meAsked).toBeGreaterThan(0); // it asked before reloading
  });

  test("does not reload while /api/me answers (a plain drop of the stream)", async ({ page, stack }) => {
    stack.setSessions(["alpha"]);
    let streams = 0;
    await page.route("**/api/events", (route) => (++streams === 1 ? route.fulfill(DROPPED) : route.continue()));
    let navigations = 0;
    page.on("framenavigated", (f) => {
      if (f === page.mainFrame()) navigations++;
    });
    await page.goto("/");
    await expect(page.getByTestId("side-row")).toHaveCount(1);
    await expect.poll(() => streams, { timeout: 10_000 }).toBeGreaterThan(1); // it came back
    const settled = navigations;
    await page.waitForTimeout(2000);
    expect(navigations).toBe(settled);
  });
});
