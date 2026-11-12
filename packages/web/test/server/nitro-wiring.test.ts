import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";
import { AUD, PROXY_KEY, goodClaims, makeKey, sign, startJwks, TEAM, type TestKey } from "./utils/guard/helpers";

// 実ファイル (server/middleware/00.guard.ts, server/api/me.get.ts) を Nitro で build して実際に起動し、HTTP で確かめる。
const pkg = fileURLToPath(new URL("../..", import.meta.url));

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer().listen(0, "127.0.0.1", () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => resolve(p));
    });
  });
}

describe("Nitro build の配線", { timeout: 300_000 }, () => {
  let key: TestKey;
  let jwks: Awaited<ReturnType<typeof startJwks>>;
  let child: ChildProcess;
  let base = "";

  before(async () => {
    key = makeKey("wire-kid");
    jwks = await startJwks([key]);
    execFileSync("node_modules/.bin/nuxt", ["build"], { cwd: pkg, stdio: "pipe" });
    const port = await freePort();
    base = `http://127.0.0.1:${port}`;
    child = spawn("node", [".output/server/index.mjs"], {
      cwd: pkg,
      stdio: "pipe",
      env: {
        PATH: process.env.PATH ?? "",
        CF_TEAM: TEAM,
        CF_AUD: AUD,
        ALLOWED_EMAILS: "alice@example.test,bob@example.test",
        PROXY_KEY,
        WEB_CF_CERTS_URL: jwks.url,
        HOST: "127.0.0.1",
        PORT: String(port),
      },
    });
    for (let i = 0; i < 100; i++) {
      try {
        await fetch(base + "/api/me");
        return;
      } catch {
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    throw new Error("server が起動しない");
  });
  after(async () => {
    child?.kill("SIGTERM");
    await jwks?.close();
  });

  const h = (jwt?: string, key: string | null = PROXY_KEY) => {
    const r: Record<string, string> = {};
    if (key !== null) r["x-bantou-proxy-key"] = key;
    if (jwt) r["cf-access-jwt-assertion"] = jwt;
    return r;
  };

  it("/api/me: 守りを通った JWT の email を返す（email は JWT ごとに変わる）", async () => {
    const r1 = await fetch(base + "/api/me", { headers: h(sign(key, goodClaims())) });
    assert.equal(r1.status, 200);
    assert.deepEqual(await r1.json(), { email: "alice@example.test" });
    const r2 = await fetch(base + "/api/me", { headers: h(sign(key, goodClaims({ email: "Bob@Example.test" }))) });
    assert.deepEqual(await r2.json(), { email: "bob@example.test" });
  });

  it("middleware が実際に掛かる: 共有鍵なし 403、JWT なし 401、許可外 email 403", async () => {
    assert.equal((await fetch(base + "/api/me", { headers: h(sign(key, goodClaims()), null) })).status, 403);
    assert.equal((await fetch(base + "/api/me", { headers: h() })).status, 401);
    const eve = sign(key, goodClaims({ email: "eve@example.test" }));
    assert.equal((await fetch(base + "/api/me", { headers: h(eve) })).status, 403);
  });

  it("存在しない route にも掛かる（守りが先、通れば SPA fallback の 200）", async () => {
    assert.equal((await fetch(base + "/api/nothing")).status, 403);
    assert.equal((await fetch(base + "/api/nothing", { headers: h() })).status, 401);
    assert.equal((await fetch(base + "/api/nothing", { headers: h(sign(key, goodClaims())) })).status, 200);
  });

  it("POST は Origin 不一致で 403", async () => {
    const jwt = sign(key, goodClaims());
    const host = new URL(base).host;
    const post = (origin: string) =>
      fetch(base + "/api/nothing", { method: "POST", headers: { ...h(jwt), origin } });
    assert.equal((await post("http://evil.example.test")).status, 403);
    assert.equal((await post(`http://${host}`)).status, 200); // 守りを通過 (SPA fallback)
  });
});
