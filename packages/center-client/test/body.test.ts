// readBodyLimited: the cap is kept while the body arrives (review of 3d, L2).

import assert from "node:assert/strict";
import { request, createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { EventEmitter } from "node:events";
import type { IncomingMessage } from "node:http";
import { readBodyLimited, readBytesLimited } from "../src/index.ts";

let server: Server;
let port = 0;
let lastRead: { ok: boolean; text?: string } | undefined;
before(async () => {
  server = createServer(async (req, res) => {
    const r = await readBodyLimited(req, 100);
    lastRead = r;
    res.writeHead(r.ok ? 200 : 413, { connection: "close" }).end(r.ok ? r.text : "too large");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as AddressInfo).port;
});
after(async () => {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
});

/** A request that fails the test (not hangs) when there is no answer in 5 s. */
function send(headers: Record<string, string>, chunks: Buffer[]): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, method: "POST", headers, timeout: 5000 }, (res) => {
      let b = "";
      res.on("data", (d) => (b += d));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: b }));
    });
    req.on("timeout", () => reject(new Error("no answer in 5 s")));
    req.on("error", reject);
    for (const c of chunks) req.write(c);
    req.end();
  });
}

test("a body within the cap is read", async () => {
  const r = await send({ "content-length": "5" }, [Buffer.from("hello")]);
  assert.deepEqual(r, { status: 200, body: "hello" });
});

test("Content-Length over the cap: 413 and the body is not read (no bytes sent at all)", async () => {
  lastRead = undefined;
  const req = await new Promise<{ status: number }>((resolve, reject) => {
    const q = request({ host: "127.0.0.1", port, method: "POST", headers: { "content-length": "400000000" }, timeout: 5000 }, (res) => {
      res.resume();
      resolve({ status: res.statusCode ?? 0 });
      q.destroy();
    });
    q.on("timeout", () => reject(new Error("no answer: the server waits for the body")));
    q.on("error", (e) => {
      if ((e as NodeJS.ErrnoException).code !== "ECONNRESET") reject(e);
    });
    q.flushHeaders();
  });
  assert.equal(req.status, 413);
  assert.deepEqual(lastRead, { ok: false });
});

test("chunked body over the cap: 413 (nothing kept)", async () => {
  const r = await send({ "transfer-encoding": "chunked" }, [Buffer.alloc(60, 97), Buffer.alloc(60, 98)]);
  assert.equal(r.status, 413);
  assert.deepEqual(lastRead, { ok: false });
});

test("chunked body within the cap is read", async () => {
  const r = await send({ "transfer-encoding": "chunked" }, [Buffer.from("ab"), Buffer.from("cd")]);
  assert.deepEqual(r, { status: 200, body: "abcd" });
});

// -- with a stand-in request: events are fired by hand, so the order of 'close' / 'end' / 'data' is exact ----------------

class FakeReq extends EventEmitter {
  headers: Record<string, string> = {};
  complete = false;
  paused = false;
  pause() {
    this.paused = true;
    return this;
  }
}
const fake = () => new FakeReq();
const asReq = (r: FakeReq) => r as unknown as IncomingMessage;
const settled = (p: Promise<unknown>) => Promise.race([p.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), 100))]);

test("closed before the whole body came (req.complete false): not a body, even when the bytes so far are within the cap", async () => {
  const r = fake();
  const p = readBytesLimited(asReq(r), 100);
  r.emit("data", Buffer.from("partial"));
  r.emit("close");
  assert.deepEqual(await p, { ok: false });
  const r2 = fake();
  const p2 = readBodyLimited(asReq(r2), 100);
  r2.emit("data", Buffer.from("partial"));
  r2.emit("close");
  assert.deepEqual(await p2, { ok: false });
});

test("close after the whole body came (req.complete true) still returns the body", async () => {
  const r = fake();
  const p = readBytesLimited(asReq(r), 100);
  r.emit("data", Buffer.from("whole"));
  r.complete = true;
  r.emit("close");
  assert.deepEqual(await p, { ok: true, bytes: Buffer.from("whole") });
});

test("a socket that goes away mid-body (real request, headers promise 100 bytes, 10 sent): not a body", async () => {
  let s!: Server;
  const got = new Promise<unknown>((resolve) => {
    s = createServer(async (req) => resolve(await readBytesLimited(req, 1000)));
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as AddressInfo).port;
      const q = request({ host: "127.0.0.1", port: p, method: "POST", headers: { "content-length": "100" } });
      q.on("error", () => {});
      q.write(Buffer.alloc(10, 97));
      setTimeout(() => q.destroy(), 50);
    });
  });
  assert.deepEqual(await got, { ok: false });
  s.closeAllConnections();
  await new Promise<void>((r) => s.close(() => r()));
});

test("after the cap, the rest is dropped only up to 4 x cap; then reading stops at once (paused, answer can go out)", async () => {
  const r = fake();
  const p = readBytesLimited(asReq(r), 100);
  r.emit("data", Buffer.alloc(150, 97)); // over the cap: nothing kept
  r.emit("data", Buffer.alloc(150, 97)); // 300 total: still draining
  assert.equal(r.paused, false);
  assert.equal(await settled(p), false); // not finished: no 'end' yet, below 4 x cap
  r.emit("data", Buffer.alloc(101, 97)); // 401 total: over 4 x cap
  assert.equal(await settled(p), true); // resolved without any 'end'
  assert.deepEqual(await p, { ok: false });
  assert.equal(r.paused, true);
  assert.equal(r.listenerCount("data"), 0);
});
