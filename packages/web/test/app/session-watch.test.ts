import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MAX_RELOADS, RELOAD_WINDOW_MS, planReload, probeSession } from "../../app/tauri/session-watch";
import { getTransport, RpcError } from "../../app/tauri/transport";

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

describe("planReload（reload の回数制限）", () => {
  it("履歴が無ければ reload し、時刻を記録する", () => {
    const p = planReload(null, 1000);
    assert.equal(p.reload, true);
    assert.deepEqual(p.list, [1000]);
  });
  it(`${MAX_RELOADS} 回続けた後は止める（許可されていない 403 で loop しない）`, () => {
    let stored: string | null = null;
    for (let i = 0; i < MAX_RELOADS; i++) {
      const p = planReload(stored, 1000 + i);
      assert.equal(p.reload, true);
      stored = JSON.stringify(p.list);
    }
    const stop = planReload(stored, 2000);
    assert.equal(stop.reload, false);
  });
  it("窓より古い履歴は数えない", () => {
    const old = JSON.stringify(Array.from({ length: MAX_RELOADS }, (_, i) => i));
    assert.equal(planReload(old, RELOAD_WINDOW_MS + 100).reload, true);
  });
  it("壊れた値は履歴なし扱い", () => {
    assert.equal(planReload("{not json", 5).reload, true);
    assert.equal(planReload('"x"', 5).reload, true);
    assert.equal(planReload('["a",null]', 5).reload, true);
  });
});

describe("invoke: 2xx の本文の扱い", () => {
  const g = globalThis as unknown as Record<string, unknown>;
  const saved = { fetch: g.fetch, sessionStorage: g.sessionStorage, location: g.location };
  const store = new Map<string, string>();
  let reloads = 0;
  const setup = (answer: (url: string) => Response) => {
    store.clear();
    reloads = 0;
    g.sessionStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v), removeItem: (k: string) => store.delete(k) };
    g.location = { reload: () => reloads++ };
    g.fetch = async (url: string) => answer(String(url));
  };
  const restore = () => {
    g.fetch = saved.fetch;
    g.sessionStorage = saved.sessionStorage;
    g.location = saved.location;
  };
  const tick = () => new Promise((r) => setTimeout(r, 20));

  it("JSON の 2xx は値になる", async () => {
    setup(() => json({ a: 1 }));
    try {
      assert.deepEqual(await getTransport().invoke("x"), { a: 1 });
    } finally {
      restore();
    }
  });
  it("本文が空の 2xx（戻り値なしの command）は undefined で通る", async () => {
    setup(() => new Response("", { status: 200 }));
    try {
      assert.equal(await getTransport().invoke("x"), undefined);
      await tick();
      assert.equal(reloads, 0);
    } finally {
      restore();
    }
  });
  it("JSON でない 2xx（login 画面の HTML）は RpcError。session を確かめ、gone なら reload", async () => {
    setup(() => new Response("<html>login</html>", { status: 200, headers: { "content-type": "text/html" } }));
    try {
      await assert.rejects(getTransport().invoke("x"), (e) => e instanceof RpcError && e.status === 200);
      await tick();
      assert.equal(reloads, 1); // /api/me も HTML = gone
    } finally {
      restore();
    }
  });
});
