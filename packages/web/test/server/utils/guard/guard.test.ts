import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { loadGuardConfig } from "../../../../server/utils/guard/config";
import { GuardError } from "../../../../server/utils/guard/errors";
import {
  ALLOWED, AUD, PROXY_KEY, goodClaims, makeGuard, makeKey, sign, startApp, startJwks,
  type TestKey,
} from "./helpers";

describe("web guard", () => {
  let keyA: TestKey, keyB: TestKey, rogue: TestKey;
  let jwks: Awaited<ReturnType<typeof startJwks>>;
  let app: Awaited<ReturnType<typeof startApp>>;

  before(async () => {
    keyA = makeKey("kid-a");
    keyB = makeKey("kid-b");
    rogue = makeKey("kid-a"); // kid は同じで鍵が違う
    jwks = await startJwks([keyA]);
    app = await startApp(makeGuard(jwks.url));
  });
  after(async () => {
    await app.close();
    await jwks.close();
  });

  const call = (
    path: string,
    o: { jwt?: string; key?: string | null; method?: string; origin?: string } = {},
  ) => {
    const headers: Record<string, string> = {};
    if (o.key !== null) headers["x-bantou-proxy-key"] = o.key ?? PROXY_KEY;
    if (o.jwt) headers["cf-access-jwt-assertion"] = o.jwt;
    if (o.origin) headers.origin = o.origin;
    return fetch(app.base + path, { method: o.method ?? "GET", headers });
  };
  const good = () => sign(keyA, goodClaims());

  it("正常系: /api/me が email を返す（小文字化）", async () => {
    const res = await call("/api/me", { jwt: good() });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { email: ALLOWED });
  });

  it("正常系: 他の route にも掛かり、通れば先へ進む", async () => {
    assert.equal((await call("/api/echo", { jwt: good() })).status, 200);
    assert.equal((await call("/api/echo")).status, 401);
  });

  it("JWT 無しは 401", async () => {
    assert.equal((await call("/api/me")).status, 401);
  });

  it("署名違い（kid は既知、鍵が別）は 401", async () => {
    assert.equal((await call("/api/me", { jwt: sign(rogue, goodClaims()) })).status, 401);
  });

  it("本文を書き換えた JWT は 401", async () => {
    const [h, , s] = good().split(".");
    const p = Buffer.from(JSON.stringify(goodClaims({ email: "bob@example.test" }))).toString("base64url");
    assert.equal((await call("/api/me", { jwt: `${h}.${p}.${s}` })).status, 401);
  });

  it("alg が RS256 でない JWT は 401（none を含む）", async () => {
    const none = `${Buffer.from('{"alg":"none","kid":"kid-a"}').toString("base64url")}.${Buffer.from(JSON.stringify(goodClaims())).toString("base64url")}.`;
    assert.equal((await call("/api/me", { jwt: none })).status, 401);
    assert.equal((await call("/api/me", { jwt: sign(keyA, goodClaims(), { alg: "HS256" }) })).status, 401);
  });

  it("壊れた JWT は 401", async () => {
    assert.equal((await call("/api/me", { jwt: "abc" })).status, 401);
    assert.equal((await call("/api/me", { jwt: "a.b.c" })).status, 401);
  });

  it("aud 違いは 401", async () => {
    assert.equal((await call("/api/me", { jwt: sign(keyA, goodClaims({ aud: ["other-aud"] })) })).status, 401);
    assert.equal((await call("/api/me", { jwt: sign(keyA, goodClaims({ aud: "other-aud" })) })).status, 401);
  });

  it("aud が文字列でも一致すれば通る", async () => {
    assert.equal((await call("/api/me", { jwt: sign(keyA, goodClaims({ aud: AUD })) })).status, 200);
  });

  it("iss 違いは 401", async () => {
    const jwt = sign(keyA, goodClaims({ iss: "https://other.cloudflareaccess.com" }));
    assert.equal((await call("/api/me", { jwt })).status, 401);
  });

  it("期限切れ・exp 無しは 401", async () => {
    const past = Math.floor(Date.now() / 1000) - 3600;
    assert.equal((await call("/api/me", { jwt: sign(keyA, goodClaims({ exp: past })) })).status, 401);
    const noExp = goodClaims();
    delete noExp.exp;
    assert.equal((await call("/api/me", { jwt: sign(keyA, noExp) })).status, 401);
  });

  it("許可外 email は 403、email 無しは 401", async () => {
    assert.equal((await call("/api/me", { jwt: sign(keyA, goodClaims({ email: "eve@example.test" })) })).status, 403);
    const noEmail = goodClaims();
    delete noEmail.email;
    assert.equal((await call("/api/me", { jwt: sign(keyA, noEmail) })).status, 401);
    assert.equal((await call("/api/me", { jwt: sign(keyA, goodClaims({ email: 42 })) })).status, 401);
  });

  it("共有鍵 header の欠落・不一致は 403（JWT が正しくても）", async () => {
    assert.equal((await call("/api/me", { jwt: good(), key: null })).status, 403);
    assert.equal((await call("/api/me", { jwt: good(), key: "wrong-key" })).status, 403);
    assert.equal((await call("/api/me", { jwt: good(), key: "" })).status, 403);
  });

  it("共有鍵が先: 鍵が無ければ JWT 無しでも 403", async () => {
    assert.equal((await call("/api/me", { key: null })).status, 403);
  });

  it("POST: Origin 一致は通り、不一致・欠落・null は 403", async () => {
    const jwt = good();
    assert.equal((await call("/api/echo", { jwt, method: "POST", origin: `http://${app.host}` })).status, 200);
    assert.equal((await call("/api/echo", { jwt, method: "POST", origin: "http://evil.example.test" })).status, 403);
    assert.equal((await call("/api/echo", { jwt, method: "POST", origin: "http://127.0.0.1:1" })).status, 403);
    assert.equal((await call("/api/echo", { jwt, method: "POST" })).status, 403);
    assert.equal((await call("/api/echo", { jwt, method: "POST", origin: "null" })).status, 403);
    for (const m of ["PUT", "PATCH", "DELETE"]) {
      assert.equal((await call("/api/echo", { jwt, method: m, origin: "http://evil.example.test" })).status, 403, m);
    }
  });

  it("GET は Origin を見ない", async () => {
    assert.equal((await call("/api/me", { jwt: good(), origin: "http://evil.example.test" })).status, 200);
  });

  it("鍵ローテーション: 未知の kid で取り直し、その後は cache から", async () => {
    const jwt = sign(keyB, goodClaims());
    assert.equal((await call("/api/me", { jwt })).status, 401); // JWKS はまだ keyB を持たない
    jwks.state.keys = [keyA, keyB];
    const before = jwks.state.fetches;
    assert.equal((await call("/api/me", { jwt })).status, 200);
    assert.equal(jwks.state.fetches, before + 1);
    assert.equal((await call("/api/me", { jwt })).status, 200);
    assert.equal(jwks.state.fetches, before + 1);
  });

  it("未知の kid は 1 リクエストにつき取り直し 1 回だけ", async () => {
    const stranger = makeKey("kid-unknown");
    const before = jwks.state.fetches;
    assert.equal((await call("/api/me", { jwt: sign(stranger, goodClaims()) })).status, 401);
    assert.equal(jwks.state.fetches, before + 1);
  });

  it("JWKS が取れない時は 401（通さない）", async () => {
    const dead = await startJwks([keyA]);
    const url = dead.url;
    await dead.close();
    const a2 = await startApp(makeGuard(url));
    try {
      const res = await fetch(a2.base + "/api/me", {
        headers: { "x-bantou-proxy-key": PROXY_KEY, "cf-access-jwt-assertion": good() },
      });
      assert.equal(res.status, 401);
    } finally {
      await a2.close();
    }
  });

  it("応答に鍵・JWT・設定値が出ない", async () => {
    const res = await call("/api/me", { jwt: sign(keyA, goodClaims({ aud: ["x"] })) });
    const text = await res.text();
    for (const secret of [PROXY_KEY, AUD]) assert.ok(!text.includes(secret));
  });
});

describe("loadGuardConfig", () => {
  const base = { CF_TEAM: "t", CF_AUD: "a", ALLOWED_EMAILS: "a@example.test", PROXY_KEY: "k" };
  it("必須項目が欠けると 500 の GuardError", () => {
    for (const k of Object.keys(base)) {
      const env = { ...base, [k]: "" };
      assert.throws(() => loadGuardConfig(env), (e: unknown) => e instanceof GuardError && e.status === 500, k);
    }
    assert.throws(() => loadGuardConfig({ ...base, ALLOWED_EMAILS: " , " }), GuardError);
  });
  it("team に host を壊す文字があれば拒否", () => {
    assert.throws(() => loadGuardConfig({ ...base, CF_TEAM: "x.evil.test/" }), GuardError);
  });
  it("鍵の取得先の既定は team から決まる", () => {
    assert.equal(loadGuardConfig(base).certsUrl, "https://t.cloudflareaccess.com/cdn-cgi/access/certs");
  });
});

describe("web guard (設定不正)", () => {
  it("設定が不正なら全 route が 500", async () => {
    const { createGuardHandler } = await import("../../../../server/utils/guard/handler");
    const { createApp, toNodeListener } = await import("h3");
    const { createServer } = await import("node:http");
    const { closeServer } = await import("./helpers");
    const a = createApp();
    a.use(createGuardHandler(() => loadGuardConfig({}) as never));
    const server = createServer(toNodeListener(a));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    try {
      const res = await fetch(`http://127.0.0.1:${(server.address() as { port: number }).port}/api/me`);
      assert.equal(res.status, 500);
    } finally {
      await closeServer(server);
    }
  });
});
