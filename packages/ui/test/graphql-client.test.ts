import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createGraphqlClient, GraphqlError } from "../api/graphql-client";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** An SSE response whose frames are pushed by the test. */
function sse() {
  let ctl!: ReadableStreamDefaultController<Uint8Array>;
  const enc = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({ start: (c) => (ctl = c) });
  return {
    res: new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } }),
    push: (s: string) => ctl.enqueue(enc.encode(s)),
    end: () => ctl.close(),
  };
}

const wait = (ms = 5) => new Promise((r) => setTimeout(r, ms));

describe("request", () => {
  test("posts the document with the target's headers and returns data", async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const c = createGraphqlClient({
      target: async () => ({ url: "http://c/graphql", headers: { authorization: "Bearer t" } }),
      fetch: (async (url: string, init: RequestInit) => {
        seen.push({ url, init });
        return json({ data: { a: 1 } });
      }) as never,
    });
    assert.deepEqual(await c.request<{ a: number }>("{ a }", { x: 1 }), { a: 1 });
    assert.equal(seen[0]!.url, "http://c/graphql");
    const h = seen[0]!.init.headers as Record<string, string>;
    assert.equal(h.authorization, "Bearer t");
    assert.equal(h.accept, "application/json");
    assert.deepEqual(JSON.parse(seen[0]!.init.body as string), { query: "{ a }", variables: { x: 1 } });
  });

  test("a GraphQL error rejects with its message alone and keeps the code", async () => {
    const c = createGraphqlClient({
      target: async () => ({ url: "/g" }),
      fetch: (async () => json({ data: null, errors: [{ message: "作業中なので眠らせない", extensions: { code: "OPERATION_FAILED" } }] })) as never,
    });
    const e = (await c.request("mutation { x }").catch((x) => x)) as GraphqlError;
    assert.ok(e instanceof GraphqlError);
    assert.equal(String(e), "作業中なので眠らせない");
    assert.equal(e.code, "OPERATION_FAILED");
  });

  test("HTTP failures, a non-JSON 200 and an unreachable endpoint reject readably", async () => {
    const mk = (f: () => Promise<Response>) => createGraphqlClient({ target: async () => ({ url: "/g" }), fetch: f as never });
    assert.equal(String(await mk(async () => new Response("no", { status: 401 })).request("{a}").catch((x) => x)), "HTTP 401");
    assert.match(String(await mk(async () => new Response("<html>", { status: 200 })).request("{a}").catch((x) => x)), /JSON でない/);
    assert.equal(String(await mk(async () => Promise.reject(new Error("refused"))).request("{a}").catch((x) => x)), "つながらない: refused");
  });
});

describe("subscribe", () => {
  test("delivers `next` frames (also split across chunks) and reports the open", async () => {
    const s = sse();
    const got: unknown[] = [];
    const opens: boolean[] = [];
    const stop = createGraphqlClient({ target: async () => ({ url: "/g" }), fetch: (async () => s.res) as never }).subscribe<{ t: number }>(
      "subscription { t }",
      () => ({}),
      { onNext: (d) => got.push(d), onOpen: (r) => opens.push(r) },
    );
    s.push(': ka\n\nevent: next\ndata: {"data":{"t":1}}\n\nevent: next\nda');
    await wait();
    s.push('ta: {"data":{"t":2}}\n\n');
    await wait();
    stop();
    assert.deepEqual(got, [{ t: 1 }, { t: 2 }]);
    assert.deepEqual(opens, [false]);
  });

  test("a dropped stream is opened again with fresh variables, and the second open says it is a reconnect", async () => {
    const streams = [sse(), sse()];
    const sentVars: unknown[] = [];
    let n = 0;
    let after = 0;
    const opens: boolean[] = [];
    const got: number[] = [];
    const stop = createGraphqlClient({
      target: async () => ({ url: "/g" }),
      reconnectDelayMs: () => 1,
      fetch: (async (_u: string, init: RequestInit) => {
        sentVars.push(JSON.parse(init.body as string).variables);
        return streams[n++]!.res;
      }) as never,
    }).subscribe<{ id: number }>("subscription { id }", () => ({ after }), {
      onNext: (d) => {
        got.push(d.id);
        after = d.id;
      },
      onOpen: (r) => opens.push(r),
    });
    await wait();
    streams[0]!.push('event: next\ndata: {"data":{"id":7}}\n\n');
    await wait();
    streams[0]!.end();
    await wait(30);
    streams[1]!.push('event: next\ndata: {"data":{"id":8}}\n\n');
    await wait();
    stop();
    assert.deepEqual(sentVars, [{ after: 0 }, { after: 7 }]);
    assert.deepEqual(opens, [false, true]);
    assert.deepEqual(got, [7, 8]);
  });

  test("a refusal (401, or a JSON error answer) is `rejected` and not retried", async () => {
    let calls = 0;
    const states: string[] = [];
    createGraphqlClient({ target: async () => ({ url: "/g" }), fetch: (async () => (calls++, new Response("", { status: 401 }))) as never }).subscribe(
      "subscription { x }",
      () => ({}),
      { onNext: () => {}, onStatus: (s) => states.push(s) },
    );
    const msgs: (string | null)[] = [];
    createGraphqlClient({ target: async () => ({ url: "/g" }), fetch: (async () => (calls++, json({ errors: [{ message: "未定義の session: x" }] }))) as never }).subscribe(
      "subscription { x }",
      () => ({}),
      { onNext: () => {}, onStatus: (_s, m) => msgs.push(m) },
    );
    await wait(30);
    assert.deepEqual(states, ["rejected"]);
    assert.deepEqual(msgs, ["未定義の session: x"]);
    assert.equal(calls, 2);
  });

  test("stop() stops the retrying", async () => {
    let calls = 0;
    const stop = createGraphqlClient({
      target: async () => ({ url: "/g" }),
      reconnectDelayMs: () => 1,
      fetch: (async () => {
        calls++;
        return Promise.reject(new Error("down"));
      }) as never,
    }).subscribe("subscription { x }", () => ({}), { onNext: () => {} });
    await wait(30);
    stop();
    const at = calls;
    await wait(30);
    assert.ok(at > 1);
    assert.equal(calls, at);
  });
});
