// Review 1 (events): secrets stay out of every error text and log line; listeners and backoff behave; no test waits for a hang.

import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { SseParser, streamOnce, type Changed, type SseEvent } from "../src/index.ts";
import { FakeCenter } from "./helpers/fake-center.ts";
import { createCenterEvents, type CenterEvents, type CenterEventsOptions } from "../src/index.ts";

/** Every subscription made by a test is stopped after it, also when the test failed (a failed test must not hang the run). */
const live: CenterEvents[] = [];
const mk = (o: CenterEventsOptions): CenterEvents => {
  const e = createCenterEvents(o);
  live.push(e);
  return e;
};
afterEach(async () => {
  await Promise.all(live.splice(0).map((e) => e.stop()));
});

const TOK = "tok-leak-0123456";
const PW = "pass-word-77";
const clean = (s: string, label: string) => {
  for (const x of [TOK, PW]) assert.ok(!s.includes(x), `${x} in ${label}: ${s}`);
};
const SECRET_URL = `http://usr:${PW}@127.0.0.1:1/mcp`;

/** Fails the test (not the runner) when `p` does not settle in `ms`. */
const within = <T>(p: Promise<T>, ms: number, label: string): Promise<T> =>
  Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`hang: ${label}`)), ms))]);

const until = async (cond: () => boolean, ms = 3000) => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error("timeout waiting for condition");
    await new Promise((r) => setTimeout(r, 10));
  }
};

const centers: FakeCenter[] = [];
afterEach(async () => {
  await Promise.all(centers.splice(0).map((c) => c.close()));
});

// -- streamOnce ---------------------------------------------------------------------

test("streamOnce: connect error text is clean (token and URL password, also with the url given without userinfo)", async () => {
  const failing = (async () => {
    throw new Error(`connect failed ${TOK} ${PW} http://usr:${PW}@h`);
  }) as unknown as typeof fetch;
  await assert.rejects(
    streamOnce(new URL("http://127.0.0.1:1/events"), () => true, { fetch: failing, token: TOK, secretUrl: SECRET_URL }),
    (e: Error) => {
      assert.ok(e.message.includes("接続できない"), e.message);
      clean(e.message, "connect");
      return true;
    },
  );
});

test("streamOnce: rejected body echo is clean", async () => {
  const f = (async () => new Response(`denied ${TOK} ${PW}`, { status: 401 })) as unknown as typeof fetch;
  const end = await streamOnce(new URL("http://127.0.0.1:1/events"), () => true, { fetch: f, token: TOK, secretUrl: SECRET_URL });
  assert.equal(end.type, "rejected");
  if (end.type === "rejected") {
    assert.ok(end.body.includes("denied") && end.status === 401);
    clean(end.body, "rejected body");
  }
});

test("streamOnce: read failure text is clean", async () => {
  const f = (async () =>
    new Response(
      new ReadableStream({
        pull(c) {
          c.error(new Error(`stream broke ${TOK} ${PW}`));
        },
      }),
      { status: 200 },
    )) as unknown as typeof fetch;
  await assert.rejects(
    streamOnce(new URL("http://127.0.0.1:1/events"), () => true, { fetch: f, token: TOK, secretUrl: SECRET_URL }),
    (e: Error) => {
      assert.ok(e.message.includes("読み取りに失敗"), e.message);
      clean(e.message, "read");
      return true;
    },
  );
});

test("streamOnce: a silent stream ends by its read timeout (no hang)", async () => {
  const f = (async () =>
    new Response(new ReadableStream({ start() {} }), { status: 200 })) as unknown as typeof fetch;
  const end = await within(
    streamOnce(new URL("http://127.0.0.1:1/events"), () => true, { fetch: f, readTimeoutMs: 100 }),
    2000,
    "read timeout",
  );
  assert.deepEqual(end, { type: "closed" });
});

// -- createCenterEvents ---------------------------------------------------------------

const fast = { targetPollMs: 20, noTargetWaitMs: 20, reconnectDelayMs: () => 10, rejectedDelayMs: 40 };

test("createCenterEvents: logger.warn is clean for a connect error and for a read error", async () => {
  for (const mode of ["connect", "read"]) {
    const warns: string[] = [];
    let calls = 0;
    const f = (async () => {
      calls++;
      if (mode === "connect") throw new Error(`connect failed ${TOK} ${PW}`);
      return new Response(
        new ReadableStream({
          pull(c) {
            c.error(new Error(`stream broke ${TOK} ${PW}`));
          },
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const events = mk({
      settings: { selectTarget: async () => ({ url: SECRET_URL, token: TOK, source: "remote" as const }) },
      fetch: f,
      logger: { warn: (m) => warns.push(m) },
      ...fast,
    });
    events.start();
    await until(() => warns.length >= 1);
    await within(events.stop(), 2000, "stop");
    assert.ok(calls >= 1);
    assert.ok(warns[0]!.startsWith("center events: "), warns[0]);
    for (const w of warns) clean(w, `${mode} warn`);
  }
});

/** A center whose /events handler is `handle(n, res)` for the n-th connection (1-based). */
function scripted(center: FakeCenter, handle: (n: number, res: import("node:http").ServerResponse) => void) {
  let n = 0;
  center.onGet = (req, res) => {
    if (req.url !== "/events") return false;
    handle(++n, res);
    return true;
  };
}

test("a listener that throws neither stops the others nor the subscription", async () => {
  const mock = await FakeCenter.start();
  centers.push(mock);
  scripted(mock, (_n, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end('event: sessions\ndata: {"reason":"created","name":"x"}\n\n');
  });
  mock.limit = 400;
  const events = mk({ settings: { selectTarget: async () => ({ url: mock.url, source: "remote" as const }) }, ...fast });
  const seen: Changed[] = [];
  events.subscribe(() => {
    throw new Error("listener bug");
  });
  events.subscribe((c) => seen.push(c));
  events.start();
  // the subscription keeps reconnecting (each connection ends at once) and keeps delivering
  await until(() => seen.length >= 3);
  await within(events.stop(), 2000, "stop");
  assert.deepEqual(seen[0], { reason: "created", name: "x" });
});

test("backoff: failures grow while a connection brings nothing, and reset after one that brought an event", async () => {
  const mock = await FakeCenter.start();
  centers.push(mock);
  scripted(mock, (n, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(n === 4 ? "event: sessions\ndata: {}\n\n" : ": nothing\n\n");
  });
  mock.limit = 400;
  const asked: number[] = [];
  const events = mk({
    settings: { selectTarget: async () => ({ url: mock.url, source: "remote" as const }) },
    ...fast,
    reconnectDelayMs: (n) => (asked.push(n), 10),
  });
  events.start();
  await until(() => asked.length >= 6);
  await within(events.stop(), 2000, "stop");
  // connections 1-3 bring nothing: 0,1,2. Connection 4 brings an event: failures reset, the wait is asked with 0. Then 1, 2.
  assert.deepEqual(asked.slice(0, 6), [0, 1, 2, 0, 1, 2]);
});

test("default backoff values are 1, 2, 4, 8, 15 s (not changed by the injection point)", async () => {
  const { reconnectDelayMs } = await import("../src/index.ts");
  assert.deepEqual([0, 1, 2, 3, 4, 9].map((n) => reconnectDelayMs(n)), [1000, 2000, 4000, 8000, 15000, 15000]);
});

test("start is idempotent: one connection, also a while after the second start", async () => {
  const mock = await FakeCenter.start();
  centers.push(mock);
  scripted(mock, (_n, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write("event: sessions\ndata: {}\n\n");
  });
  const events = mk({ settings: { selectTarget: async () => ({ url: mock.url, source: "remote" as const }) }, ...fast });
  events.start();
  events.start();
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(mock.gets, 1);
  await within(events.stop(), 2000, "stop");
});

test("stop aborts a connection that is open and silent, and nothing is opened after it", async () => {
  const mock = await FakeCenter.start();
  centers.push(mock);
  scripted(mock, (_n, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write("event: sessions\ndata: {}\n\n");
  });
  const events = mk({
    settings: { selectTarget: async () => ({ url: mock.url, source: "remote" as const }) },
    ...fast,
    readTimeoutMs: 60_000, // only stop() can end this connection within the test
  });
  const got: Changed[] = [];
  events.subscribe((c) => got.push(c));
  events.start();
  await until(() => got.length === 1);
  await within(events.stop(), 1500, "stop with an open connection");
  const gets = mock.gets;
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(mock.gets, gets);
  // and it can start again
  events.start();
  await until(() => mock.gets === gets + 1);
  await within(events.stop(), 1500, "second stop");
});

test("the token is sent on the events request", async () => {
  const mock = await FakeCenter.start();
  centers.push(mock);
  const auth: (string | undefined)[] = [];
  scripted(mock, (_n, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write("event: sessions\ndata: {}\n\n");
  });
  const orig = mock.onGet!;
  mock.onGet = (req, res) => (auth.push(req.headers.authorization), orig(req, res));
  const events = mk({
    settings: { selectTarget: async () => ({ url: mock.url, token: "tok-abcdefghij", source: "remote" as const }) },
    ...fast,
  });
  events.start();
  await until(() => auth.length >= 1);
  await within(events.stop(), 2000, "stop");
  assert.equal(auth[0], "Bearer tok-abcdefghij");
});

// -- SseParser -------------------------------------------------------------------------

test("SseParser: comment lines are ignored, also between and inside an event", () => {
  const p = new SseParser();
  const out: SseEvent[] = [];
  const enc = new TextEncoder();
  out.push(...p.feed(enc.encode(": top\ndata: a\n: middle\ndata: b\n:event: no\n\n: tail\n\n")));
  assert.deepEqual(out, [{ id: undefined, event: "message", data: "a\nb" }]);
});
