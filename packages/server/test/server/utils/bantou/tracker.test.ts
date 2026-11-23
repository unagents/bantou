import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createTracker, TRACKER_INTERVAL_MS, type TrackerSocket } from "../../../../server/utils/bantou/tracker";

class FakeSocket implements TrackerSocket {
  readyState = 0;
  sent: string[] = [];
  closed = false;
  private l: Record<string, Array<() => void>> = {};
  send(d: string): void {
    this.sent.push(d);
  }
  close(): void {
    this.closed = true;
    this.readyState = 3;
  }
  addEventListener(t: "open" | "error" | "close", fn: () => void): void {
    (this.l[t] ??= []).push(fn);
  }
  emit(t: "open" | "error" | "close"): void {
    if (t === "open") this.readyState = 1;
    for (const fn of this.l[t] ?? []) fn();
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

test("tracker: 間隔は 5 秒", () => {
  assert.equal(TRACKER_INTERVAL_MS, 5000);
});

test("tracker: 間隔の間に出力が在った時だけ { parent-id, at } を 1 行書く。無音の間は書かない", async () => {
  const sock = new FakeSocket();
  sock.readyState = 1;
  const t = createTracker({ parentId: "cap-1", ws: "ws://x", intervalMs: 30, connect: () => sock, now: () => new Date("2026-11-23T01:02:03.000Z") });
  await sleep(80);
  assert.deepEqual(sock.sent, [], "無音の間は書かない");
  t.touch();
  t.touch();
  t.touch();
  await sleep(50);
  assert.equal(sock.sent.length, 1, "間隔の間の出力は何回でも 1 行");
  assert.deepEqual(JSON.parse(sock.sent[0] as string), { "parent-id": "cap-1", at: "2026-11-23T01:02:03.000Z" });
  assert.deepEqual(Object.keys(JSON.parse(sock.sent[0] as string)).sort(), ["at", "parent-id"]);
  await sleep(80);
  assert.equal(sock.sent.length, 1, "出力が止まれば書かない");
  t.touch();
  await sleep(50);
  assert.equal(sock.sent.length, 2);
  t.close();
  assert.equal(sock.closed, true);
});

test("tracker: ws の error / close の後は書かない。close 後の touch も書かない", async () => {
  const a = new FakeSocket();
  a.readyState = 1;
  const logs: string[] = [];
  const t = createTracker({ parentId: "c", ws: "ws://x", intervalMs: 20, connect: () => a, log: (m) => logs.push(m) });
  a.emit("error");
  t.touch();
  await sleep(50);
  assert.deepEqual(a.sent, []);
  assert.ok(logs.some((l) => l.includes("接続エラー")));
  t.close();

  const b = new FakeSocket();
  b.readyState = 1;
  const t2 = createTracker({ parentId: "c", ws: "ws://x", intervalMs: 20, connect: () => b });
  t2.close();
  t2.touch();
  await sleep(50);
  assert.deepEqual(b.sent, []);
});

test("tracker: ws が切れたら繋ぎ直す（間隔は reconnectMs、既定 5 秒）。切れている間の書き込みは捨てる。tracker を閉じたら繋ぎ直さない", async () => {
  const socks: FakeSocket[] = [];
  const connect = (): FakeSocket => {
    const s = new FakeSocket();
    socks.push(s);
    return s;
  };
  const t = createTracker({ parentId: "c", ws: "ws://x", intervalMs: 20, reconnectMs: 40, connect });
  socks[0]!.emit("open");
  t.touch();
  await sleep(30);
  assert.equal(socks[0]!.sent.length, 1);
  // 切れる → 切れている間（繋ぎ直す前）の出力は書かない・溜めない
  socks[0]!.emit("close");
  t.touch();
  await sleep(25);
  assert.equal(socks.length, 1, "間隔を置くまで繋ぎ直さない");
  assert.equal(socks[0]!.sent.length, 1);
  await sleep(60);
  assert.equal(socks.length, 2, "繋ぎ直す");
  socks[1]!.emit("open");
  assert.deepEqual(socks[1]!.sent, [], "切れていた間の分は溜めていない");
  t.touch();
  await sleep(40);
  assert.equal(socks[1]!.sent.length, 1, "繋ぎ直した後は書く");
  // error でも繋ぎ直す。繋ぎ直しは繋がるまで続く
  socks[1]!.emit("error");
  await sleep(70);
  assert.equal(socks.length, 3);
  socks[2]!.emit("close");
  await sleep(70);
  assert.equal(socks.length, 4);
  t.close();
  socks[3]!.emit("close");
  await sleep(100);
  assert.equal(socks.length, 4, "閉じた後は繋ぎ直さない");
});

test("tracker: 開けない（connect が投げる）間も繋がるまで繋ぎ直す", async () => {
  const sock = new FakeSocket();
  let n = 0;
  const t = createTracker({
    parentId: "c",
    ws: "ws://x",
    intervalMs: 20,
    reconnectMs: 30,
    connect: () => {
      if (++n < 3) throw new Error("refused");
      return sock;
    },
  });
  await sleep(120);
  assert.equal(n, 3);
  sock.emit("open");
  t.touch();
  await sleep(40);
  assert.equal(sock.sent.length, 1);
  t.close();
});

test("tracker: ws を開けない（connect が投げる）時もログだけで落ちない", async () => {
  const logs: string[] = [];
  const t = createTracker({
    parentId: "c",
    ws: "bad",
    intervalMs: 20,
    connect: () => {
      throw new Error("bad url");
    },
    log: (m) => logs.push(m),
  });
  t.touch();
  await sleep(40);
  t.close();
  assert.ok(logs.some((l) => l.includes("bad url")));
});

test("tracker: log に ws の token（?token=...）を出さない（接続エラー・開けない・書けない）", async () => {
  const url = "ws://center.example:9/ws?token=SECRET123";
  // 接続エラー
  const logs1: string[] = [];
  const s = new FakeSocket();
  const t1 = createTracker({ parentId: "c", ws: url, intervalMs: 20, connect: () => s, log: (m) => logs1.push(m) });
  s.emit("error");
  t1.close();
  assert.ok(logs1.length === 1 && logs1[0]!.includes("ws://center.example:9/ws?***"), logs1.join("|"));
  // connect が URL 入りの文言で投げる
  const logs2: string[] = [];
  const t2 = createTracker({
    parentId: "c",
    ws: url,
    connect: () => {
      throw new Error(`Invalid URL: ${url}`);
    },
    log: (m) => logs2.push(m),
  });
  t2.close();
  assert.ok(logs2.length === 1 && logs2[0]!.includes("Invalid URL: ws://center.example:9/ws?***"), logs2.join("|"));
  // send が URL 入りの文言で投げる
  const logs3: string[] = [];
  const s3 = new FakeSocket();
  s3.send = () => {
    throw new Error(`write failed to ${url}`);
  };
  const t3 = createTracker({ parentId: "c", ws: url, intervalMs: 20, connect: () => s3, log: (m) => logs3.push(m) });
  s3.emit("open");
  t3.touch();
  await sleep(50);
  t3.close();
  assert.ok(logs3.length === 1 && !logs3[0]!.includes("SECRET123"), logs3.join("|"));
  for (const l of [...logs1, ...logs2, ...logs3]) assert.ok(!l.includes("SECRET123"), l);
});

test("tracker: 実 WebSocket（global）で ws の受け側に 1 行届く", async () => {
  const received: string[] = [];
  // 受け側は最小の WebSocket サーバ（ws パッケージ無し）: handshake して text frame を読む
  const { createHash } = await import("node:crypto");
  const server = createServer();
  const sockets = new Set<import("node:stream").Duplex>();
  server.on("upgrade", (req, socket) => {
    sockets.add(socket as import("node:net").Socket);
    const key = req.headers["sec-websocket-key"] as string;
    const accept = createHash("sha1").update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    socket.on("data", (buf: Buffer) => {
      // client → server は mask 付き。1 frame・短い payload だけ読む
      const len = (buf[1] as number) & 0x7f;
      const mask = buf.subarray(2, 6);
      const payload = Buffer.from(buf.subarray(6, 6 + len));
      for (let i = 0; i < payload.length; i++) payload[i] = (payload[i] as number) ^ (mask[i % 4] as number);
      if (((buf[0] as number) & 0x0f) === 1) received.push(payload.toString("utf8"));
    });
    socket.on("error", () => {});
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  const t = createTracker({ parentId: "cap-9", ws: `ws://127.0.0.1:${port}/x`, intervalMs: 30 });
  try {
    await sleep(100); // 接続を待つ
    t.touch();
    await sleep(100);
    assert.equal(received.length, 1);
    const body = JSON.parse(received[0] as string) as Record<string, string>;
    assert.equal(body["parent-id"], "cap-9");
    assert.ok(!Number.isNaN(Date.parse(body.at as string)));
  } finally {
    t.close();
    for (const s of sockets) s.destroy();
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
});
