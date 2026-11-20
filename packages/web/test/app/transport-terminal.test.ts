import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { getTransport, RpcError } from "../../app/tauri/transport";

// 端末系 command の HTTP への写し（設計 3.2 / 5.1）。fetch と EventSource を注入して、送る先・body・header と、
// SSE の frame が desktop の `session-output` / `session-output-status` event になる所を確かめる。
const g = globalThis as unknown as Record<string, unknown>;
const saved = { fetch: g.fetch, EventSource: g.EventSource, sessionStorage: g.sessionStorage, location: g.location, document: g.document, window: g.window };

interface Call {
  url: string;
  init: RequestInit;
}
let calls: Call[] = [];

class FakeES {
  static CLOSED = 2;
  static all: FakeES[] = [];
  readyState = 1;
  closed = false;
  handlers = new Map<string, ((e: unknown) => void)[]>();
  constructor(public url: string) {
    FakeES.all.push(this);
  }
  addEventListener(t: string, f: (e: unknown) => void) {
    this.handlers.set(t, [...(this.handlers.get(t) ?? []), f]);
  }
  removeEventListener() {}
  close() {
    this.closed = true;
    this.readyState = 2;
  }
  emit(t: string, e: unknown = {}) {
    for (const f of this.handlers.get(t) ?? []) f(e);
  }
}

beforeEach(() => {
  calls = [];
  FakeES.all = [];
  g.fetch = async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify({ ok: true, saved: ["/p/x.png"], errors: [] }), { status: 200, headers: { "content-type": "application/json" } });
  };
  g.EventSource = FakeES;
  g.sessionStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  g.location = { reload() {} };
  g.document = { addEventListener() {}, removeEventListener() {}, visibilityState: "visible" };
  g.window = { addEventListener() {}, removeEventListener() {} };
});
afterEach(() => {
  Object.assign(g, saved);
});

describe("session_input / session_resize", () => {
  it("input は JSON {data} を /api/sessions/:n/input へ POST（session は path、args の dataB64 が data）", async () => {
    await getTransport().invoke("session_input", { session: "a b", dataB64: "bHM=" });
    assert.equal(calls[0]!.url, "/api/sessions/a%20b/input");
    assert.equal(calls[0]!.init.method, "POST");
    assert.deepEqual(JSON.parse(String(calls[0]!.init.body)), { data: "bHM=" });
    assert.equal((calls[0]!.init.headers as Record<string, string>)["content-type"], "application/json");
  });
  it("resize は {cols, rows} を /resize へ POST", async () => {
    await getTransport().invoke("session_resize", { session: "alpha", cols: 80, rows: 24 });
    assert.equal(calls[0]!.url, "/api/sessions/alpha/resize");
    assert.deepEqual(JSON.parse(String(calls[0]!.init.body)), { cols: 80, rows: 24 });
  });
  it("RPC の route（/api/rpc/）は通さない", async () => {
    await getTransport().invoke("session_input", { session: "alpha", dataB64: "" });
    assert.ok(!calls[0]!.url.startsWith("/api/rpc/"));
  });
});

describe("session_attach_bytes", () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
  it("body の bytes を画像の Content-Type で /attachments へ POST（x-bantou-session は header に出さない）", async () => {
    const out = await getTransport().invoke<{ saved: string[] }>("session_attach_bytes", undefined, { headers: { "x-bantou-session": "alpha" }, body: png });
    assert.deepEqual(out.saved, ["/p/x.png"]);
    assert.equal(calls[0]!.url, "/api/sessions/alpha/attachments");
    const h = calls[0]!.init.headers as Record<string, string>;
    assert.equal(h["content-type"], "image/png");
    assert.equal(h["x-bantou-session"], undefined);
    assert.equal(calls[0]!.init.body, png);
  });
  it("型は先頭 bytes で決める（jpeg / gif / webp）", async () => {
    const cases: [number[], string][] = [
      [[0xff, 0xd8, 0xff, 0xe0], "image/jpeg"],
      [[0x47, 0x49, 0x46, 0x38, 0x39, 0x61], "image/gif"],
      [[0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50], "image/webp"],
    ];
    for (const [bytes, type] of cases) {
      calls = [];
      await getTransport().invoke("session_attach_bytes", undefined, { headers: { "x-bantou-session": "alpha" }, body: new Uint8Array(bytes) });
      assert.equal((calls[0]!.init.headers as Record<string, string>)["content-type"], type);
    }
  });
  it("画像でない bytes は送らず RpcError", async () => {
    await assert.rejects(
      getTransport().invoke("session_attach_bytes", undefined, { headers: { "x-bantou-session": "alpha" }, body: new Uint8Array([1, 2, 3]) }),
      (e) => e instanceof RpcError,
    );
    assert.equal(calls.length, 0);
  });
  it("端末系以外の command に body は付けられない", async () => {
    await assert.rejects(getTransport().invoke("center_get_settings", undefined, { body: png }), (e) => e instanceof RpcError);
    assert.equal(calls.length, 0);
  });
});

describe("session_output_start / stop", () => {
  const collect = async () => {
    const out: unknown[] = [];
    const status: unknown[] = [];
    const un1 = await getTransport().listen("session-output", (p) => out.push(p));
    const un2 = await getTransport().listen("session-output-status", (p) => status.push(p));
    return { out, status, stop: () => (un1(), un2()) };
  };

  it("start は /api/sessions/:n/output を開く（after があれば ?after=）。frame が desktop の event になる", async () => {
    const { out, status, stop } = await collect();
    await getTransport().invoke("session_output_start", { session: "alpha", after: 41 });
    const es = FakeES.all.at(-1)!;
    assert.equal(es.url, "/api/sessions/alpha/output?after=41");
    es.emit("output", { data: "aGk=", lastEventId: "42" });
    es.emit("reset");
    es.emit("status", { data: JSON.stringify({ session: "alpha", state: "connected", message: null }) });
    assert.deepEqual(out, [
      { session: "alpha", id: 42, data: "aGk=", reset: false },
      { session: "alpha", id: 0, data: "", reset: true },
    ]);
    assert.deepEqual(status, [{ session: "alpha", state: "connected", message: null }]);
    stop();
  });
  it("after が null なら query 無し。id が整数でない frame は捨てる", async () => {
    const { out, stop } = await collect();
    await getTransport().invoke("session_output_start", { session: "alpha", after: null });
    const es = FakeES.all.at(-1)!;
    assert.equal(es.url, "/api/sessions/alpha/output");
    es.emit("output", { data: "aGk=", lastEventId: "" });
    es.emit("output", { data: "aGk=", lastEventId: "x" });
    assert.deepEqual(out, []);
    stop();
  });
  it("stop は stream を閉じ、閉じた後の frame は event にならない。同じ session の再 start は前を閉じる", async () => {
    const { out, stop } = await collect();
    await getTransport().invoke("session_output_start", { session: "alpha", after: null });
    const first = FakeES.all.at(-1)!;
    await getTransport().invoke("session_output_start", { session: "alpha", after: 1 });
    assert.ok(first.closed);
    const second = FakeES.all.at(-1)!;
    await getTransport().invoke("session_output_stop", { session: "alpha" });
    assert.ok(second.closed);
    assert.equal(calls.length, 0, "start / stop は fetch しない");
    stop();
    assert.deepEqual(out, []);
  });
  it("browser が再接続の途中なら retrying、その後 open で connected", async () => {
    const { status, stop } = await collect();
    await getTransport().invoke("session_output_start", { session: "alpha", after: null });
    const es = FakeES.all.at(-1)!;
    es.emit("open");
    es.emit("error"); // readyState は CLOSED でない
    es.emit("open");
    assert.deepEqual(status, [
      { session: "alpha", state: "retrying", message: null },
      { session: "alpha", state: "connected", message: null },
    ]);
    await getTransport().invoke("session_output_stop", { session: "alpha" });
    stop();
  });
  it("browser が諦めた（CLOSED）ら、session を確かめた後に rejected", async () => {
    const { status, stop } = await collect();
    await getTransport().invoke("session_output_start", { session: "alpha", after: null });
    const es = FakeES.all.at(-1)!;
    es.readyState = 2;
    es.emit("error");
    await new Promise((r) => setTimeout(r, 30));
    assert.deepEqual(status, [{ session: "alpha", state: "rejected", message: "output stream closed" }]);
    stop();
  });
});
