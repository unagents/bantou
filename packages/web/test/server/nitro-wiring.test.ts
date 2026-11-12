import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import type { AddressInfo } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";
import { AUD, PROXY_KEY, goodClaims, makeKey, sign, startJwks, TEAM, type TestKey } from "./utils/guard/helpers";

// 実ファイル (server/middleware/00.guard.ts, server/api/me.get.ts) を Nitro で build して実際に起動し、HTTP で確かめる。
const pkg = fileURLToPath(new URL("../..", import.meta.url));

// nuxt の bin は node_modules の hoist 先に依らず、解決した package.json の bin から求める
function nuxtBin(): string {
  const pj = createRequire(import.meta.url).resolve("nuxt/package.json");
  const bin = (JSON.parse(readFileSync(pj, "utf8")) as { bin: Record<string, string> }).bin.nuxt;
  return resolve(dirname(pj), bin);
}

// 偽 center（127.0.0.1 のみ）。端末の route が中継する先
const CENTER_TOKEN = "center-token-SECRET-0123456789";
interface Seen {
  method: string;
  url: string;
  auth: string | undefined;
  lastEventId: string | undefined;
  contentType: string | undefined;
  body: Buffer;
}

async function startFakeCenter() {
  const seen: Seen[] = [];
  const open = new Set<ServerResponse>();
  const server: Server = createHttpServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const url = req.url ?? "";
      seen.push({
        method: req.method ?? "",
        url,
        auth: req.headers.authorization,
        lastEventId: req.headers["last-event-id"] as string | undefined,
        contentType: req.headers["content-type"],
        body: Buffer.concat(chunks),
      });
      if (req.method === "GET" && url === "/sessions/live/output") {
        res.writeHead(200, { "content-type": "text/event-stream" });
        const last = req.headers["last-event-id"];
        const id = typeof last === "string" ? Number(last) + 1 : 1;
        res.write(`id: ${id}\nevent: output\ndata: QUJD\n\n`);
        open.add(res);
        res.on("close", () => open.delete(res));
        return;
      }
      if (req.method === "GET" && (url === "/sessions/badnl/output" || url === "/sessions/badchar/output")) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        // 改行入りの data（SSE の別行になる）／ base64 でない data
        res.write(url.includes("badnl") ? "id: 3\nevent: output\ndata: QUJD\ndata: injected-line\n\n" : "id: 3\nevent: output\ndata: !!not-base64!!\n\n");
        open.add(res);
        res.on("close", () => open.delete(res));
        return;
      }
      if (req.method === "GET" && url.startsWith("/sessions/") && url.endsWith("/output")) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(`{"error":"no such session ${CENTER_TOKEN}"}`);
        return;
      }
      if (req.method === "POST" && url === "/sessions/auth/input") {
        res.writeHead(401, { "content-type": "text/plain" });
        res.end(`unauthorized ${CENTER_TOKEN}`);
        return;
      }
      if (req.method === "POST" && url === "/sessions/failatt/attachments") {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(`{"error":"disk ${CENTER_TOKEN}"}`);
        return;
      }
      if (req.method === "POST" && url === "/sessions/dead/input") {
        res.writeHead(409, { "content-type": "application/json" });
        res.end("{}");
        return;
      }
      if (req.method === "POST" && url === "/sessions/echo/input") {
        res.writeHead(500, { "content-type": "text/plain" });
        res.end(`boom ${CENTER_TOKEN}`);
        return;
      }
      if (req.method === "POST" && url.endsWith("/attachments")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ path: "/saved/a.png", bytes: Buffer.concat(chunks).length, type: req.headers["content-type"] }));
        return;
      }
      res.writeHead(204);
      res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  return {
    seen,
    url: `http://127.0.0.1:${port}/mcp`,
    close: () =>
      new Promise<void>((r) => {
        for (const o of open) o.destroy();
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer().listen(0, "127.0.0.1", () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => resolve(p));
    });
  });
}

describe("Nitro build の配線", { timeout: 300_000 }, () => {
  let key: TestKey;
  let jwks: Awaited<ReturnType<typeof startJwks>>;
  let child: ChildProcess;
  let base = "";
  let center: Awaited<ReturnType<typeof startFakeCenter>>;
  let tmp = "";

  before(async () => {
    key = makeKey("wire-kid");
    jwks = await startJwks([key]);
    center = await startFakeCenter();
    tmp = mkdtempSync(join(tmpdir(), "bantou-web-wire-"));
    execFileSync(process.execPath, [nuxtBin(), "build"], { cwd: pkg, stdio: "pipe" });
    const port = await freePort();
    base = `http://127.0.0.1:${port}`;
    child = spawn("node", [".output/server/index.mjs"], {
      cwd: pkg,
      stdio: "pipe",
      env: {
        PATH: process.env.PATH ?? "",
        CF_TEAM: TEAM,
        CF_AUD: AUD,
        ALLOWED_EMAILS: "alice@example.test,bob@example.test",
        PROXY_KEY,
        WEB_CF_CERTS_URL: jwks.url,
        CENTER_URL: center.url,
        CENTER_TOKEN,
        WEB_SETTINGS_FILE: join(tmp, "settings.json"),
        HOST: "127.0.0.1",
        PORT: String(port),
      },
    });
    for (let i = 0; i < 100; i++) {
      try {
        await fetch(base + "/api/me");
        return;
      } catch {
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    throw new Error("server が起動しない");
  });
  after(async () => {
    child?.kill("SIGTERM");
    await jwks?.close();
    await center?.close();
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });

  const h = (jwt?: string, key: string | null = PROXY_KEY) => {
    const r: Record<string, string> = {};
    if (key !== null) r["x-bantou-proxy-key"] = key;
    if (jwt) r["cf-access-jwt-assertion"] = jwt;
    return r;
  };

  it("/api/me: 守りを通った JWT の email を返す（email は JWT ごとに変わる）", async () => {
    const r1 = await fetch(base + "/api/me", { headers: h(sign(key, goodClaims())) });
    assert.equal(r1.status, 200);
    assert.deepEqual(await r1.json(), { email: "alice@example.test" });
    const r2 = await fetch(base + "/api/me", { headers: h(sign(key, goodClaims({ email: "Bob@Example.test" }))) });
    assert.deepEqual(await r2.json(), { email: "bob@example.test" });
  });

  it("middleware が実際に掛かる: 共有鍵なし 403、JWT なし 401、許可外 email 403", async () => {
    assert.equal((await fetch(base + "/api/me", { headers: h(sign(key, goodClaims()), null) })).status, 403);
    assert.equal((await fetch(base + "/api/me", { headers: h() })).status, 401);
    const eve = sign(key, goodClaims({ email: "eve@example.test" }));
    assert.equal((await fetch(base + "/api/me", { headers: h(eve) })).status, 403);
  });

  it("存在しない route にも掛かる（守りが先、通れば SPA fallback の 200）", async () => {
    assert.equal((await fetch(base + "/api/nothing")).status, 403);
    assert.equal((await fetch(base + "/api/nothing", { headers: h() })).status, 401);
    assert.equal((await fetch(base + "/api/nothing", { headers: h(sign(key, goodClaims())) })).status, 200);
  });

  it("POST は Origin 不一致で 403", async () => {
    const jwt = sign(key, goodClaims());
    const host = new URL(base).host;
    const post = (origin: string) =>
      fetch(base + "/api/nothing", { method: "POST", headers: { ...h(jwt), origin } });
    assert.equal((await post("http://evil.example.test")).status, 403);
    assert.equal((await post(`http://${host}`)).status, 200); // 守りを通過 (SPA fallback)
  });

  // -- 4b: 端末の route --------------------------------------------------------------------

  const routes: Array<[string, string]> = [
    ["GET", "/api/sessions/live/output"],
    ["POST", "/api/sessions/live/input"],
    ["POST", "/api/sessions/live/resize"],
    ["POST", "/api/sessions/live/attachments"],
  ];
  const ok = () => h(sign(key, goodClaims()));
  const post = (path: string, body: unknown, extra: Record<string, string> = {}) =>
    fetch(base + path, { method: "POST", headers: { ...ok(), origin: new URL(base).origin, "content-type": "application/json", ...extra }, body: JSON.stringify(body) });

  async function readSse(path: string, headers: Record<string, string>, until: (t: string) => boolean) {
    const ctrl = new AbortController();
    const res = await fetch(base + path, { headers, signal: ctrl.signal });
    const dec = new TextDecoder();
    const reader = res.body!.getReader();
    let text = "";
    const stop = setTimeout(() => ctrl.abort(), 10_000);
    try {
      while (!until(text)) {
        const { value, done } = await reader.read();
        if (done) break;
        text += dec.decode(value, { stream: true });
      }
    } finally {
      clearTimeout(stop);
      ctrl.abort();
    }
    return { res, text };
  }

  it("端末の route も守りの内側: 共有鍵なし 403、JWT なし 401、許可外 email 403、Origin 不一致 403（center へは届かない）", async () => {
    const before = center.seen.length;
    const eve = sign(key, goodClaims({ email: "eve@example.test" }));
    for (const [method, path] of routes) {
      assert.equal((await fetch(base + path, { method, headers: h(sign(key, goodClaims()), null) })).status, 403, path);
      assert.equal((await fetch(base + path, { method, headers: h() })).status, 401, path);
      assert.equal((await fetch(base + path, { method, headers: h(eve) })).status, 403, path);
      if (method === "POST") {
        const r = await fetch(base + path, { method, headers: { ...ok(), origin: "http://evil.example.test" }, body: "{}" });
        assert.equal(r.status, 403, path);
      }
    }
    assert.equal(center.seen.length, before);
  });

  it("output: SSE が流れる（header 即 flush・X-Accel-Buffering、token は center へだけ）。Last-Event-ID と after を渡す", async () => {
    const a = await readSse("/api/sessions/live/output", ok(), (t) => t.includes("event: output"));
    assert.equal(a.res.status, 200);
    assert.match(a.res.headers.get("content-type") ?? "", /text\/event-stream/);
    assert.equal(a.res.headers.get("x-accel-buffering"), "no");
    assert.match(a.text, /id: 1\nevent: output\ndata: QUJD\n\n/);
    assert.equal(a.text.includes(CENTER_TOKEN), false);
    const first = center.seen.filter((s) => s.url === "/sessions/live/output").at(-1)!;
    assert.equal(first.auth, `Bearer ${CENTER_TOKEN}`);
    assert.equal(first.lastEventId, undefined);

    const b = await readSse("/api/sessions/live/output?after=41", ok(), (t) => t.includes("event: output"));
    assert.match(b.text, /id: 42\n/);
    const c = await readSse("/api/sessions/live/output?after=1", { ...ok(), "last-event-id": "9" }, (t) => t.includes("event: output"));
    assert.match(c.text, /id: 10\n/); // 再接続の Last-Event-ID が先
    const bad = await fetch(base + "/api/sessions/live/output?after=x", { headers: ok() });
    assert.equal(bad.status, 400);
    assert.equal((await fetch(base + "/api/sessions/a%20b/output", { headers: ok() })).status, 400);
  });

  it("output: center が拒否したら status rejected を流して閉じる（token は出ない）", async () => {
    const r = await readSse("/api/sessions/nope/output", ok(), () => false);
    assert.match(r.text, /event: status\ndata: .*"state":"rejected"/);
    assert.equal(r.text.includes(CENTER_TOKEN), false);
  });

  it("output: 2 クライアントが同時に購読できる", async () => {
    const [x, y] = await Promise.all([
      readSse("/api/sessions/live/output", ok(), (t) => t.includes("event: output")),
      readSse("/api/sessions/live/output", ok(), (t) => t.includes("event: output")),
    ]);
    assert.match(x.text, /event: output/);
    assert.match(y.text, /event: output/);
  });

  it("input / resize: 検査して center へ中継（token 付き）。不正な入力は center へ届かない", async () => {
    const n = center.seen.length;
    assert.equal((await post("/api/sessions/live/input", { data: "QQ==" })).status, 200);
    assert.equal((await post("/api/sessions/live/resize", { cols: 80, rows: 24 })).status, 200);
    const sent = center.seen.slice(n);
    assert.deepEqual(sent.map((s) => [s.method, s.url, s.auth]), [
      ["POST", "/sessions/live/input", `Bearer ${CENTER_TOKEN}`],
      ["POST", "/sessions/live/resize", `Bearer ${CENTER_TOKEN}`],
    ]);
    assert.deepEqual(JSON.parse(sent[0]!.body.toString()), { data: "QQ==" });
    assert.deepEqual(JSON.parse(sent[1]!.body.toString()), { cols: 80, rows: 24 });
    const m = center.seen.length;
    for (const body of [{ data: 1 }, { data: "a-_b" }, {}, { data: "QQ===" }]) assert.equal((await post("/api/sessions/live/input", body)).status, 400, JSON.stringify(body));
    for (const body of [{ cols: 0, rows: 24 }, { cols: 80, rows: 1001 }, { cols: "8", rows: 2 }, {}]) assert.equal((await post("/api/sessions/live/resize", body)).status, 400, JSON.stringify(body));
    assert.equal((await post("/api/sessions/a%20b/input", { data: "QQ==" })).status, 400);
    const raw = await fetch(base + "/api/sessions/live/input", { method: "POST", headers: { ...ok(), origin: new URL(base).origin }, body: "not json" });
    assert.equal(raw.status, 400);
    assert.equal(center.seen.length, m);
  });

  it("output: center の data が改行入り／base64 でないと、その chunk は流さず status rejected で閉じる", async () => {
    for (const name of ["badnl", "badchar"]) {
      const r = await readSse(`/api/sessions/${name}/output`, ok(), () => false);
      assert.match(r.text, /event: status\ndata: .*"state":"rejected"/, name);
      assert.equal(r.text.includes("injected-line"), false, name);
      assert.equal(r.text.includes("event: output"), false, name);
      assert.equal(r.text.includes("not-base64"), false, name);
    }
  });

  it("input: center の 401 は 502（ブラウザの認証と混同させない）で token は出ない", async () => {
    const r = await post("/api/sessions/auth/input", { data: "QQ==" });
    assert.equal(r.status, 502);
    assert.equal((await r.text()).includes(CENTER_TOKEN), false);
  });

  it("attachments: center が保存に失敗(0 件)なら 502、本文の token は出ない", async () => {
    const r = await upload(PNG, "image/png", "failatt");
    assert.equal(r.status, 502);
    const t = await r.text();
    assert.equal(t.includes(CENTER_TOKEN), false);
    assert.match(t, /\*\*\*/);
  });

  // chunked（Content-Length 無し）の body は受信中に数える。超えたら読み捨てて 413（接続は reset しない）
  const chunked = (total: number, first: Buffer) => {
    const piece = 1024 * 1024;
    let sent = 0;
    return new ReadableStream<Uint8Array>({
      pull(c) {
        if (sent >= total) return c.close();
        const n = Math.min(piece, total - sent);
        const b = Buffer.alloc(n);
        if (sent === 0) first.copy(b);
        sent += n;
        c.enqueue(new Uint8Array(b));
      },
    });
  };
  const chunkedPost = (path: string, headers: Record<string, string>, body: ReadableStream<Uint8Array>) =>
    fetch(base + path, { method: "POST", headers: { ...ok(), origin: new URL(base).origin, ...headers }, body, duplex: "half" } as RequestInit);

  it("attachments: chunked で 25MB は 413（reset ではなく応答が返り、center へは届かない）", async () => {
    const n = center.seen.length;
    const r = await chunkedPost("/api/sessions/live/attachments", { "content-type": "image/png" }, chunked(25 * 1024 * 1024, PNG));
    assert.equal(r.status, 413);
    assert.equal(center.seen.length, n);
  });

  it("input: chunked の JSON が 1MiB を超えたら 413（center へは届かない）", async () => {
    const n = center.seen.length;
    const r = await chunkedPost("/api/sessions/live/input", { "content-type": "application/json" }, chunked(3 * 1024 * 1024, Buffer.from("{")));
    assert.equal(r.status, 413);
    const small = await post("/api/sessions/live/input", { data: "QQ==" });
    assert.equal(small.status, 200);
    assert.equal(center.seen.length, n + 1);
  });

  it("input: center の 409 は 409、center が token を含む本文を返しても応答に出ない", async () => {
    assert.equal((await post("/api/sessions/dead/input", { data: "QQ==" })).status, 409);
    const r = await post("/api/sessions/echo/input", { data: "QQ==" });
    assert.equal(r.status, 502);
    assert.equal((await r.text()).includes(CENTER_TOKEN), false);
  });

  const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);
  const upload = (body: Buffer, type: string | null, session = "live") =>
    fetch(base + `/api/sessions/${session}/attachments`, { method: "POST", headers: { ...ok(), origin: new URL(base).origin, ...(type ? { "content-type": type } : {}) }, body: new Uint8Array(body) });

  it("attachments: 画像 1 枚を中継し、保存先 path を pty に入力する", async () => {
    const n = center.seen.length;
    const r = await upload(PNG, "image/png");
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { saved: ["/saved/a.png"], errors: [] });
    const sent = center.seen.slice(n);
    assert.equal(sent[0]!.url, "/sessions/live/attachments");
    assert.equal(sent[0]!.contentType, "image/png");
    assert.equal(sent[0]!.auth, `Bearer ${CENTER_TOKEN}`);
    assert.deepEqual(sent[0]!.body, PNG);
    assert.equal(sent[1]!.url, "/sessions/live/input");
    assert.equal(JSON.parse(sent[1]!.body.toString()).data, Buffer.from(" /saved/a.png ").toString("base64"));
  });

  it("attachments: 型違い 415、空 400、20MB 超 413（center へは届かない）、20MB ちょうどは通る", async () => {
    const n = center.seen.length;
    assert.equal((await upload(PNG, "text/plain")).status, 415);
    assert.equal((await upload(PNG, null)).status, 415);
    assert.equal((await upload(Buffer.from("not an image at all"), "image/png")).status, 415); // 先頭 bytes が画像でない
    assert.equal((await upload(Buffer.from("GIF89a" + "x".repeat(20)), "image/png")).status, 415); // 申告と実際が違う
    assert.equal((await upload(Buffer.alloc(0), "image/png")).status, 400);
    const big = Buffer.concat([PNG, Buffer.alloc(20 * 1024 * 1024 - PNG.length + 1)]);
    assert.equal(big.length, 20 * 1024 * 1024 + 1);
    assert.equal((await upload(big, "image/png")).status, 413);
    assert.equal(center.seen.length, n);
    const exact = Buffer.concat([PNG, Buffer.alloc(20 * 1024 * 1024 - PNG.length)]);
    assert.equal((await upload(exact, "image/png")).status, 200);
  });
});
