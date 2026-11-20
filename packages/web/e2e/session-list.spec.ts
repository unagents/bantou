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
  test("the SPA's HTML and built /_nuxt asset are not served without the shared key / JWT", async ({ stack }) => {
    const key = stack.headers["x-bantou-proxy-key"]!;
    const jwt = stack.headers["cf-access-jwt-assertion"]!;
    // the entry asset's name comes from the page itself
    const html = await (await fetch(stack.base + "/", { headers: stack.headers })).text();
    const asset = html.match(/\/_nuxt\/[^"'\s]+\.js/)?.[0];
    expect(asset, "the SPA HTML names a /_nuxt/*.js entry").toBeTruthy();
    const get = (path: string, headers: Record<string, string>) => fetch(stack.base + path, { headers });
    for (const path of ["/", asset!]) {
      expect((await get(path, {})).status, `${path}: no key, no JWT`).toBe(403);
      expect((await get(path, { "cf-access-jwt-assertion": jwt })).status, `${path}: JWT only`).toBe(403);
      expect((await get(path, { "x-bantou-proxy-key": key })).status, `${path}: key only`).toBe(401);
      const ok = await get(path, stack.headers);
      expect(ok.status, `${path}: key and JWT`).toBe(200);
      expect((await ok.text()).length).toBeGreaterThan(50);
    }
  });

  test("a browser without the headers gets no page", async ({ stack, browser }) => {
    const ctx = await browser.newContext({ extraHTTPHeaders: {} }); // no Cloudflare headers
    const page = await ctx.newPage();
    const res = await page.goto(stack.base + "/");
    expect(res?.status()).toBe(403);
    expect(await page.content()).not.toContain("_nuxt");
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

  test("stream fails -> /api/me asked -> reload (in that order); a refusal that reloading cannot fix ends in a message, not a loop", async ({ page, stack }) => {
    stack.setSessions(["alpha"]);
    // Cloudflare after the Access session is gone: a redirect to the login page for the stream, the login page (HTML 200) for /api/me
    const order: string[] = [];
    let streams = 0;
    await page.route("**/api/events", (route) => {
      if (++streams === 1) return route.fulfill(DROPPED);
      order.push("stream-failed");
      return route.fulfill({ status: 302, headers: { location: "/cdn-cgi/access/login" } });
    });
    await page.route("**/cdn-cgi/access/login", (route) => route.fulfill({ status: 200, contentType: "text/html", body: "<html>login</html>" }));
    await page.route("**/api/me", (route) => {
      order.push("me");
      return route.fulfill({ status: 200, contentType: "text/html", body: "<html>login</html>" });
    });
    let loads = 0;
    page.on("load", () => {
      if (++loads > 1) order.push("reload");
    });
    await page.goto("/");
    await expect(page.getByTestId("access-denied")).toBeVisible({ timeout: 20_000 });
    expect(loads).toBe(3); // the page, and MAX_RELOADS (2) reloads; then it stops
    // every reload came after a failed stream and an /api/me question
    expect(order.slice(0, 3)).toEqual(["stream-failed", "me", "reload"]);
    expect(order.indexOf("reload")).toBeGreaterThan(order.indexOf("me"));
    expect(order.filter((x) => x === "reload")).toHaveLength(2);
  });

  test("does not reload while /api/me answers (the stream fails to connect three times, then comes back)", async ({ page, stack }) => {
    stack.setSessions(["alpha"]);
    let streams = 0;
    await page.route("**/api/events", (route) => (++streams <= 3 ? route.abort("connectionrefused") : route.continue()));
    let loads = 0;
    page.on("load", () => loads++);
    const me = page.waitForResponse((r) => r.url().endsWith("/api/me")); // three failures make it ask
    await page.goto("/");
    expect((await me).status()).toBe(200); // the backend's own answer: the session is fine
    const loadsAtAnswer = loads;
    await expect.poll(() => streams, { timeout: 10_000 }).toBeGreaterThan(3); // the stream came back
    await expect(page.getByTestId("side-row")).toHaveCount(1);
    expect(loads).toBe(loadsAtAnswer);
    await expect(page.getByTestId("access-denied")).toHaveCount(0);
  });
});
