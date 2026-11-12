// readBodyLimited: the cap is kept while the body arrives (review of 3d, L2).

import assert from "node:assert/strict";
import { request, createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { readBodyLimited } from "../src/index.ts";

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
