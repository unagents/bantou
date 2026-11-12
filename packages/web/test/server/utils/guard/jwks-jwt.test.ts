import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { GuardError } from "../../../../server/utils/guard/errors";
import { JwksCache } from "../../../../server/utils/guard/jwks";
import { verifyAccessJwt } from "../../../../server/utils/guard/jwt";
import { ALLOWED, fakeFetch, goodClaims, makeGuard, makeKey, sign } from "./helpers";

const config = makeGuard("http://unused.invalid/").config;
const NOW = 1_800_000_000;

describe("JwksCache", () => {
  it("TTL 内は取り直さず、TTL 失効後の最初の get で 1 回だけ取り直す", async () => {
    const a = makeKey("a");
    const { st, fetch } = fakeFetch([a]);
    let t = 0;
    const c = new JwksCache({ url: "x", fetch, ttlMs: 1000, now: () => t });
    assert.ok(await c.get("a"));
    assert.equal(st.calls, 1);
    t = 1000;
    assert.ok(await c.get("a"));
    assert.equal(st.calls, 1); // 境界ちょうどは失効していない
    t = 1001;
    assert.ok(await c.get("a"));
    assert.equal(st.calls, 2);
  });

  it("未知の kid の取り直しは 1 回だけ（cache 新鮮でも失効後でも）", async () => {
    const a = makeKey("a");
    const { st, fetch } = fakeFetch([a]);
    let t = 0;
    const c = new JwksCache({ url: "x", fetch, ttlMs: 1000, now: () => t });
    await c.get("a");
    assert.equal(await c.get("zzz"), undefined);
    assert.equal(st.calls, 2); // 新鮮: 取り直し 1 回
    t = 5000;
    assert.equal(await c.get("zzz"), undefined);
    assert.equal(st.calls, 3); // 失効: 取得 1 回で済み、さらに重ねない
  });

  it("同時の取得は 1 本にまとまる", async () => {
    const a = makeKey("a");
    const { st, fetch } = fakeFetch([a]);
    const c = new JwksCache({ url: "x", fetch });
    await Promise.all([c.get("a"), c.get("a"), c.get("a")]);
    assert.equal(st.calls, 1);
  });

  for (const [name, body, ok] of [
    ["keys が空", { keys: [] }, true],
    ["keys が無い", {}, true],
    ["鍵が不正", { keys: [{ kty: "RSA", kid: "bad", n: "!", e: "AQAB" }, { kty: "EC", kid: "ec" }] }, true],
    ["HTTP エラー", { keys: [] }, false],
  ] as const) {
    it(`取得成功でも ${name} の応答は既存 cache を置換しない`, async () => {
      const a = makeKey("a");
      const { st, fetch } = fakeFetch([a]);
      let t = 0;
      const c = new JwksCache({ url: "x", fetch, ttlMs: 1000, now: () => t });
      assert.ok(await c.get("a"));
      st.body = body;
      st.ok = ok;
      t = 2000; // 失効 → 取り直し
      assert.ok(await c.get("a"), "旧 cache の鍵が残る");
    });
  }
});

describe("verifyAccessJwt (時刻・正規化)", () => {
  const key = makeKey("k");
  const jwks = () => new JwksCache({ url: "x", fetch: fakeFetch([key]).fetch });
  const run = (claims: Record<string, unknown>, now = NOW) =>
    verifyAccessJwt(sign(key, goodClaims(claims)), config, jwks(), now);
  const status = async (p: Promise<unknown>) => {
    try {
      await p;
      return 200;
    } catch (e) {
      assert.ok(e instanceof GuardError);
      return e.status;
    }
  };

  it("exp の leeway 境界（30 秒）", async () => {
    assert.equal(await status(run({ exp: NOW - 30 })), 200);
    assert.equal(await status(run({ exp: NOW - 31 })), 401);
  });

  it("nbf: 未来は 401、leeway 内は通る", async () => {
    assert.equal(await status(run({ exp: NOW + 100, nbf: NOW + 30 })), 200);
    assert.equal(await status(run({ exp: NOW + 100, nbf: NOW + 31 })), 401);
    assert.equal(await status(run({ exp: NOW + 100, nbf: NOW - 5 })), 200);
  });

  it("JWT の email の大文字・前後空白は正規化して照合し、小文字で返す", async () => {
    const id = await run({ exp: NOW + 100, email: `  ${ALLOWED.toUpperCase()} ` });
    assert.equal(id.email, ALLOWED);
  });
});
