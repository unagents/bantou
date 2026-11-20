import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { probeSession } from "../../app/tauri/session-watch";

// `/api/me` の見方（Access の session 切れ検知、設計 5.2）。ブラウザの fetch の結果を注入して確かめる
const fakeFetch = (r: () => Promise<Response> | Response): typeof fetch => (async () => r()) as unknown as typeof fetch;
const json = (body: unknown, init?: ResponseInit) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" }, ...init });

describe("probeSession", () => {
  it("email が返れば ok", async () => {
    assert.equal(await probeSession(fakeFetch(() => json({ email: "a@example.test" }))), "ok");
  });
  it("401 / 403 は gone（reload の対象）", async () => {
    assert.equal(await probeSession(fakeFetch(() => json({}, { status: 401 }))), "gone");
    assert.equal(await probeSession(fakeFetch(() => json({}, { status: 403 }))), "gone");
  });
  it("redirect（Access の login への誘導）は gone", async () => {
    const r = { type: "opaqueredirect", ok: false, status: 0 } as unknown as Response;
    assert.equal(await probeSession(fakeFetch(() => r)), "gone");
  });
  it("200 でも JSON でない・email が無い（login 画面）は gone", async () => {
    assert.equal(await probeSession(fakeFetch(() => new Response("<html>login</html>", { status: 200 }))), "gone");
    assert.equal(await probeSession(fakeFetch(() => json({ ok: true }))), "gone");
  });
  it("応答が全く無い（回線が無い）は offline。reload しない", async () => {
    assert.equal(await probeSession(fakeFetch(() => Promise.reject(new TypeError("Failed to fetch")))), "offline");
  });
});
