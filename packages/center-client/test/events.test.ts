// Inputs and expectations copied from the Rust tests of the desktop (design 5.6 #5).
// E = packages/desktop/src-tauri/src/center_events.rs, T = .../terminal.rs (SSE parsing, `stream_once`, `center_url`).
// The center is a fake HTTP server on 127.0.0.1.

import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, test } from "node:test";
import {
  SseParser,
  centerUrl,
  createCenterEvents,
  eventsUrl,
  reconnectDelayMs,
  retryDelayMs,
  streamOnce,
  toChanged,
  type Changed,
  type SseEvent,
  type Target,
} from "../src/index.ts";
import { FakeCenter } from "./helpers/fake-center.ts";

const ev = (event: string, data: string): SseEvent => ({ id: undefined, event, data });
const enc = new TextEncoder();

// -- pure parts -------------------------------------------------------------------

test("E:131 sessions event carries reason and name", () => {
  assert.deepEqual(toChanged(ev("sessions", '{"reason":"created","name":"pm-a"}')), { reason: "created", name: "pm-a" });
});

test("E:137 the event sent on connect has an empty payload", () => {
  assert.deepEqual(toChanged(ev("sessions", "{}")), { reason: null, name: null });
});

test("E:143 unreadable data still triggers a refetch", () => {
  assert.deepEqual(toChanged(ev("sessions", "not json")), { reason: null, name: null });
});

test("E:148 other events are ignored", () => {
  assert.equal(toChanged(ev("output", "{}")), undefined);
  assert.equal(toChanged(ev("message", "{}")), undefined);
});

test("E:154 changed serializes with the event field names", () => {
  assert.deepEqual(JSON.parse(JSON.stringify({ reason: "deleted", name: "x" } satisfies Changed)), { reason: "deleted", name: "x" });
});

test("E:160 events url is on the mcp origin", () => {
  assert.equal(eventsUrl("http://127.0.0.1:7910/mcp").href, "http://127.0.0.1:7910/events");
  assert.equal(eventsUrl("http://mac200:7910/mcp?x=1").href, "http://mac200:7910/events");
  assert.throws(() => eventsUrl("nope"));
  // no userinfo goes along (fetch refuses it), the session name is a percent-encoded segment
  assert.equal(eventsUrl("http://u:p@h:1/mcp").href, "http://h:1/events");
  assert.equal(centerUrl("http://h:1/mcp", ["sessions", "a/b c", "output"]).href, "http://h:1/sessions/a%2Fb%20c/output");
});

test("E:167 retry delay backs off and waits long after a rejection", () => {
  assert.equal(retryDelayMs({ type: "closed" }, 0), 1000);
  assert.equal(retryDelayMs(new Error("x"), 2), 4000);
  assert.equal(retryDelayMs({ type: "rejected", status: 404, body: "" }, 0), 60_000);
});

test("T:486 reconnect delay backs off and caps", () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6].map((n) => reconnectDelayMs(n) / 1000), [1, 2, 4, 8, 15, 15, 15]);
});

test("sse parser: CRLF, CR, split chunks, comments, multi-line data, default event name, id", () => {
  const p = new SseParser();
  const got: SseEvent[] = [];
  const feed = (s: string) => got.push(...p.feed(enc.encode(s)));
  feed("id: 4\r\nevent: output\r\nda");
  feed("ta: a\r\ndata: b\r\n\r");
  feed("\n: ka\n\n");
  feed("data: x\rdata: y\r\r");
  feed("event: sessions\ndata\n\n");
  assert.deepEqual(got, [
    { id: "4", event: "output", data: "a\nb" },
    { id: "4", event: "message", data: "x\ny" },
    { id: "4", event: "sessions", data: "" },
  ]);
  // a multi-byte character split between chunks survives
  const q = new SseParser();
  const bytes = enc.encode("data: あ\n\n");
  const out = [...q.feed(bytes.slice(0, 7)), ...q.feed(bytes.slice(7))];
  assert.equal(out[0]!.data, "あ");
});

// -- streamOnce on a tiny server ----------------------------------------------------

const servers: Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) {
    s.closeAllConnections();
    await new Promise<void>((r) => s.close(() => r()));
  }
});

/** Answers each connection with the next canned status/body and records the request. */
async function serve(responses: [number, string][]): Promise<{ base: string; heads: IncomingMessage[] }> {
  const heads: IncomingMessage[] = [];
  let i = 0;
  const srv = createServer((req, res) => {
    heads.push(req);
    const [status, body] = responses[Math.min(i++, responses.length - 1)]!;
    res.writeHead(status, { "content-type": "text/event-stream", connection: "close" }).end(body);
  });
  servers.push(srv);
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  return { base: `http://127.0.0.1:${(srv.address() as AddressInfo).port}`, heads };
}

test("T:512 stream_once delivers events and sends last-event-id and token", async () => {
  const { base, heads } = await serve([[200, "event: reset\ndata: {}\n\n: ka\n\nid: 4\nevent: output\ndata: QQ==\n\n"]]);
  const got: SseEvent[] = [];
  const end = await streamOnce(centerUrl(`${base}/mcp`, ["sessions", "m", "output"]), (e) => (got.push(e), true), {
    token: "tok",
    lastEventId: 3,
    readTimeoutMs: 5000,
  });
  assert.deepEqual(end, { type: "closed" });
  assert.deepEqual(got.map((e) => e.event), ["reset", "output"]);
  assert.equal(heads[0]!.url, "/sessions/m/output");
  assert.equal(heads[0]!.headers.authorization, "Bearer tok");
  assert.equal(heads[0]!.headers["last-event-id"], "3");
});

test("T:532 stream_once omits last-event-id when none and reports rejection", async () => {
  const { base, heads } = await serve([[404, "no such session"]]);
  const end = await streamOnce(centerUrl(`${base}/mcp`, ["sessions", "gone", "output"]), () => true, { readTimeoutMs: 5000 });
  assert.deepEqual(end, { type: "rejected", status: 404, body: "no such session" });
  assert.equal(heads[0]!.headers["last-event-id"], undefined);
  assert.equal(heads[0]!.headers.authorization, undefined);
});

test("T:567 stream_once stops when the sink says so", async () => {
  const { base } = await serve([[200, "id: 1\nevent: output\ndata: QQ==\n\nid: 2\nevent: output\ndata: Qg==\n\n"]]);
  let n = 0;
  const end = await streamOnce(centerUrl(`${base}/mcp`, ["sessions", "m", "output"]), () => (n++, false), { readTimeoutMs: 5000 });
  assert.deepEqual([end, n], [{ type: "stopped" }, 1]);
});

test("T:582 silent connection is dropped after the read timeout", async () => {
  const srv = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(": hello\n\n");
  });
  servers.push(srv);
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  const end = await streamOnce(centerUrl(`${base}/mcp`, ["events"]), () => true, { readTimeoutMs: 300 });
  assert.deepEqual(end, { type: "closed" });
});

test("stream_once: an unreachable center throws a text without secrets", async () => {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const port = (s.address() as AddressInfo).port;
  await new Promise<void>((r) => s.close(() => r()));
  await assert.rejects(streamOnce(new URL(`http://127.0.0.1:${port}/events`), () => true, { token: "tok-secret-123" }), (e: Error) => {
    assert.ok(e.message.includes("接続できない") && !e.message.includes("tok-secret-123"), e.message);
    return true;
  });
});

// -- createCenterEvents on the fake center ------------------------------------------------

const centers: FakeCenter[] = [];
afterEach(async () => {
  await Promise.all(centers.splice(0).map((c) => c.close()));
});

const until = async (cond: () => boolean, ms = 3000) => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error("timeout waiting for condition");
    await new Promise((r) => setTimeout(r, 10));
  }
};

/** The center's `/events`: `sessions` on connect, then whatever `push` sends; keeps the connection open. */
function eventsHandler(center: FakeCenter) {
  const opened: IncomingMessage[] = [];
  const open = new Set<import("node:http").ServerResponse>();
  center.onGet = (req, res) => {
    if (req.url !== "/events") return false;
    opened.push(req);
    if (center.requiredToken !== undefined && req.headers.authorization !== `Bearer ${center.requiredToken}`) {
      res.writeHead(401).end("unauthorized");
      return true;
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write("event: sessions\ndata: {}\n\n");
    open.add(res);
    res.on("close", () => open.delete(res));
    return true;
  };
  return {
    opened,
    push: (data: object) => open.forEach((r) => r.write(`event: sessions\ndata: ${JSON.stringify(data)}\n\n`)),
    dropAll: () => open.forEach((r) => r.end()),
  };
}

const fast = { targetPollMs: 20, noTargetWaitMs: 20, reconnectDelayMs: () => 20, rejectedDelayMs: 40 };

test("one subscription feeds every listener; the token is sent; stop ends it", async () => {
  const mock = await FakeCenter.start("tok-abcdefghij");
  centers.push(mock);
  const h = eventsHandler(mock);
  const events = createCenterEvents({
    settings: { selectTarget: async () => ({ url: mock.url, token: "tok-abcdefghij", source: "remote" as const }) },
    ...fast,
  });
  const a: Changed[] = [];
  const b: Changed[] = [];
  events.subscribe((c) => a.push(c));
  const offB = events.subscribe((c) => b.push(c));
  events.start();
  events.start(); // idempotent
  await until(() => a.length === 1);
  h.push({ reason: "created", name: "n1" });
  await until(() => a.length === 2 && b.length === 2);
  assert.deepEqual(a, [{ reason: null, name: null }, { reason: "created", name: "n1" }]);
  assert.deepEqual(b, a);
  assert.equal(h.opened.length, 1);
  assert.equal(h.opened[0]!.headers.authorization, "Bearer tok-abcdefghij");
  offB();
  h.push({ reason: "deleted", name: "n1" });
  await until(() => a.length === 3);
  assert.equal(b.length, 2);
  await events.stop();
  await events.stop(); // idempotent
  const n = h.opened.length;
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(h.opened.length, n);
});

test("a closed connection is reopened and the first event after it is delivered", async () => {
  const mock = await FakeCenter.start();
  centers.push(mock);
  const h = eventsHandler(mock);
  const events = createCenterEvents({ settings: { selectTarget: async () => ({ url: mock.url, source: "remote" as const }) }, ...fast });
  const got: Changed[] = [];
  events.subscribe((c) => got.push(c));
  events.start();
  await until(() => got.length === 1);
  h.dropAll();
  await until(() => h.opened.length === 2 && got.length === 2);
  await events.stop();
});

test("a target change reconnects to the new center at once; no target waits and then connects", async () => {
  const [a, b] = [await FakeCenter.start(), await FakeCenter.start()];
  centers.push(a, b);
  const ha = eventsHandler(a);
  const hb = eventsHandler(b);
  let target: Target | undefined;
  const events = createCenterEvents({ settings: { selectTarget: async () => target }, ...fast });
  const got: Changed[] = [];
  events.subscribe((c) => got.push(c));
  events.start();
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(got.length, 0);
  target = { url: a.url, source: "remote" };
  await until(() => got.length === 1);
  assert.equal(ha.opened.length, 1);
  target = { url: b.url, source: "remote" };
  await until(() => hb.opened.length === 1 && got.length === 2);
  // the old connection is dropped by the client; nothing more is opened on `a`
  assert.equal(ha.opened.length, 1);
  // same url, new token = another target
  target = { url: b.url, token: "other-token-123", source: "remote" };
  await until(() => hb.opened.length === 2);
  await events.stop();
});

test("a rejected token is asked again only after the long delay", async () => {
  const mock = await FakeCenter.start("tok-abcdefghij");
  centers.push(mock);
  const h = eventsHandler(mock);
  const warns: string[] = [];
  const events = createCenterEvents({
    settings: { selectTarget: async () => ({ url: mock.url, token: "wrong-token-xyz", source: "remote" as const }) },
    ...fast,
    rejectedDelayMs: 150,
    logger: { warn: (m) => warns.push(m) },
  });
  events.start();
  await until(() => h.opened.length === 1);
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(h.opened.length, 1);
  await until(() => h.opened.length === 2);
  await events.stop();
  for (const w of warns) assert.ok(!w.includes("wrong-token-xyz"), w);
});
