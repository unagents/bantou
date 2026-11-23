import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { WebSocket } from "ws";
import { attachWorkerWs, createWorkerTracker, parseWorkerLines, tokenMatches, workerHostOf, workerWsUrl, WORKER_WS_PATH, SILENT_MS } from "../src/worker-ws.js";

const TOKEN = "test-token-123456";

async function start() {
  const tracker = createWorkerTracker();
  const http: Server = createServer((_req, res) => res.writeHead(404).end());
  const ws = attachWorkerWs(http, { token: TOKEN, tracker, log: () => {} });
  await new Promise<void>((r) => http.listen(0, "127.0.0.1", r));
  const port = (http.address() as AddressInfo).port;
  const close = async (): Promise<void> => {
    ws.close();
    http.closeAllConnections();
    await new Promise<void>((r) => http.close(() => r()));
  };
  return { tracker, port, close };
}

const open = (url: string): Promise<WebSocket> =>
  new Promise((resolve, reject) => {
    const s = new WebSocket(url);
    s.once("open", () => resolve(s));
    s.once("error", reject);
    s.once("unexpected-response", (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
  });

const until = async (cond: () => boolean, ms = 2000): Promise<void> => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 10));
  }
};

test("tracker: 書き込みから 60 秒以内は running、無音なら stopped。forget で消える。変化は onChange に届く", () => {
  let t = 5_000;
  const tr = createWorkerTracker({ now: () => t });
  assert.equal(tr.silentMs, SILENT_MS);
  assert.equal(tr.stateOf("a-cap"), "stopped");
  assert.equal(tr.lastAt("a-cap"), undefined);
  const seen: string[] = [];
  const off = tr.onChange((id) => void seen.push(id));
  tr.note("a-cap");
  assert.equal(tr.stateOf("a-cap"), "running");
  t += SILENT_MS - 1;
  assert.equal(tr.stateOf("a-cap"), "running");
  t += 1;
  assert.equal(tr.stateOf("a-cap"), "stopped");
  tr.note("a-cap");
  assert.equal(tr.stateOf("a-cap"), "running");
  assert.equal(tr.lastAt("a-cap"), t);
  tr.forget("a-cap");
  assert.equal(tr.stateOf("a-cap"), "stopped");
  off();
  tr.note("b-cap");
  assert.deepEqual(seen, ["a-cap", "a-cap", "a-cap"]);
});

test("parseWorkerLines: 1 行の JSON / 改行区切りの連続を受ける。parent-id・at が不正な行・JSON でない行は捨てる", () => {
  const ok = { "parent-id": "pm1-cap", at: "2026-11-23T13:00:00.000Z" };
  assert.deepEqual(parseWorkerLines(JSON.stringify(ok)), [ok]);
  assert.deepEqual(parseWorkerLines(`${JSON.stringify(ok)}\n${JSON.stringify({ ...ok, "parent-id": "pm2-cap" })}\r\n\n`), [ok, { ...ok, "parent-id": "pm2-cap" }]);
  assert.deepEqual(parseWorkerLines("not json\n[1]\n{}\n"), []);
  assert.deepEqual(parseWorkerLines(JSON.stringify({ "parent-id": "", at: ok.at })), []);
  assert.deepEqual(parseWorkerLines(JSON.stringify({ "parent-id": "a\0b", at: ok.at })), []);
  assert.deepEqual(parseWorkerLines(JSON.stringify({ "parent-id": "x", at: "yesterday" })), []);
  assert.deepEqual(parseWorkerLines(JSON.stringify({ "parent-id": 1, at: ok.at })), []);
});

test("tokenMatches: 一致だけ通す。無い・違う・長さの違うものは通さない", () => {
  assert.equal(tokenMatches(TOKEN, TOKEN), true);
  assert.equal(tokenMatches(null, TOKEN), false);
  assert.equal(tokenMatches("", TOKEN), false);
  assert.equal(tokenMatches(`${TOKEN}x`, TOKEN), false);
});

test("workerHostOf: ws と同じ元（publicHost 優先、無ければ loopback・wildcard 以外の bind、IPv6 は []）", () => {
  assert.equal(workerHostOf({ bind: "127.0.0.1", publicHost: "10.0.0.5" }), "10.0.0.5");
  assert.equal(workerHostOf({ bind: "192.168.1.9" }), "192.168.1.9");
  assert.equal(workerHostOf({ bind: "0.0.0.0" }), undefined);
  assert.equal(workerHostOf({ bind: "::1", publicHost: "fd00::5" }), "[fd00::5]");
});

test("workerWsUrl: publicHost 優先。無ければ bind（loopback・wildcard 以外）。どちらも無ければ undefined。IPv6 は []、token は encode", () => {
  assert.equal(workerWsUrl({ bind: "127.0.0.1", port: 7910, token: "t", publicHost: "10.0.0.5" }), `ws://10.0.0.5:7910${WORKER_WS_PATH}?token=t`);
  assert.equal(workerWsUrl({ bind: "192.168.1.9", port: 7910, token: "a b" }), `ws://192.168.1.9:7910${WORKER_WS_PATH}?token=a%20b`);
  assert.equal(workerWsUrl({ bind: "127.0.0.1", port: 7910, token: "t" }), undefined);
  assert.equal(workerWsUrl({ bind: "localhost", port: 7910, token: "t" }), undefined);
  assert.equal(workerWsUrl({ bind: "0.0.0.0", port: 7910, token: "t" }), undefined);
  assert.equal(workerWsUrl({ bind: "::", port: 7910, token: "t" }), undefined);
  assert.equal(workerWsUrl({ bind: "0.0.0.0", port: 7910, token: "t", publicHost: "center.example" }), `ws://center.example:7910${WORKER_WS_PATH}?token=t`);
  assert.equal(workerWsUrl({ bind: "::1", port: 7910, token: "t", publicHost: "fd00::5" }), `ws://[fd00::5]:7910${WORKER_WS_PATH}?token=t`);
});

test("ws の口: token が合えば接続でき、1 行 = 1 text frame（連続も）で書かれた parent-id の最後の書き込みを記録する", async () => {
  const s = await start();
  try {
    const c = await open(`ws://127.0.0.1:${s.port}${WORKER_WS_PATH}?token=${TOKEN}`);
    c.send(JSON.stringify({ "parent-id": "pm1-cap", at: new Date().toISOString() }));
    await until(() => s.tracker.stateOf("pm1-cap") === "running");
    c.send(`${JSON.stringify({ "parent-id": "pm2-cap", at: new Date().toISOString() })}\n${JSON.stringify({ "parent-id": "pm3-cap", at: new Date().toISOString() })}`);
    await until(() => s.tracker.stateOf("pm2-cap") === "running" && s.tracker.stateOf("pm3-cap") === "running");
    // 不正な行・binary は無視（接続は保たれる）
    c.send("garbage");
    c.send(Buffer.from([1, 2, 3]));
    c.send(JSON.stringify({ "parent-id": "pm4-cap", at: new Date().toISOString() }));
    await until(() => s.tracker.stateOf("pm4-cap") === "running");
    assert.equal(s.tracker.stateOf("garbage"), "stopped");
    c.close();
  } finally {
    await s.close();
  }
});

test("ws の口: Authorization: Bearer でも通る。token が違う・無い・別の path は拒否（401 / 404）して記録しない", async () => {
  const s = await start();
  try {
    await assert.rejects(() => open(`ws://127.0.0.1:${s.port}${WORKER_WS_PATH}?token=wrong-token-123456`), /HTTP 401/);
    await assert.rejects(() => open(`ws://127.0.0.1:${s.port}${WORKER_WS_PATH}`), /HTTP 401/);
    await assert.rejects(() => open(`ws://127.0.0.1:${s.port}/ws/other?token=${TOKEN}`), /HTTP 404/);
    assert.equal(s.tracker.stateOf("pm1-cap"), "stopped");
    const bearer = await new Promise<WebSocket>((resolve, reject) => {
      const c = new WebSocket(`ws://127.0.0.1:${s.port}${WORKER_WS_PATH}`, { headers: { authorization: `Bearer ${TOKEN}` } });
      c.once("open", () => resolve(c));
      c.once("error", reject);
    });
    bearer.send(JSON.stringify({ "parent-id": "pm1-cap", at: new Date().toISOString() }));
    await until(() => s.tracker.stateOf("pm1-cap") === "running");
    bearer.close();
  } finally {
    await s.close();
  }
});
