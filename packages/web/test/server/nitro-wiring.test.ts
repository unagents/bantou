import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { request as httpRequest } from "node:http";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";
import { FakeCenter } from "../../../center-client/test/helpers/fake-center";
import { AUD, PROXY_KEY, goodClaims, makeKey, sign, startJwks, TEAM, type TestKey } from "./utils/guard/helpers";

// 実ファイル (server/middleware/00.guard.ts, server/api/me.get.ts) を Nitro で build して実際に起動し、HTTP で確かめる。
const pkg = fileURLToPath(new URL("../..", import.meta.url));

// nuxt の bin は node_modules の hoist 先に依らず、解決した package.json の bin から求める
function nuxtBin(): string {
  const pj = createRequire(import.meta.url).resolve("nuxt/package.json");
  const bin = (JSON.parse(readFileSync(pj, "utf8")) as { bin: Record<string, string> }).bin.nuxt;
  return resolve(dirname(pj), bin);
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
  // 3d: 偽 center と設定 file（起動時は存在しない）。child の出力は全部集めて最後に secret が無いことを見る
  const CENTER_TOKEN = "wire-center-token-0123456789";
  const CENTER_PASS = "wire-pw-Zx9Qq7Lm";
  let center: FakeCenter;
  let settingsFile = "";
  let childLog = "";

  before(async () => {
    key = makeKey("wire-kid");
    jwks = await startJwks([key]);
    center = await FakeCenter.start(CENTER_TOKEN);
    settingsFile = join(mkdtempSync(join(tmpdir(), "bantou-web-wire-")), "settings.json");
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
        WEB_SETTINGS_FILE: settingsFile,
        HOST: "127.0.0.1",
        PORT: String(port),
      },
    });
    child.stdout?.on("data", (d) => (childLog += d));
    child.stderr?.on("data", (d) => (childLog += d));
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
    if (settingsFile) rmSync(dirname(settingsFile), { recursive: true, force: true });
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

  // ---- 3d: /api/rpc/:cmd, /api/events, /api/health ----
  const jwt = () => sign(key, goodClaims());
  const origin = () => `http://${new URL(base).host}`;
  const rpc = (cmd: string, body?: unknown, o: { origin?: string | null; jwt?: string | null } = {}) => {
    const headers: Record<string, string> = { ...h(o.jwt === null ? undefined : (o.jwt ?? jwt())), "content-type": "application/json" };
    if (o.origin !== null) headers.origin = o.origin ?? origin();
    return fetch(`${base}/api/rpc/${cmd}`, { method: "POST", headers, body: body === undefined ? undefined : JSON.stringify(body) });
  };
  const noSecret = (s: string, what: string) => {
    assert.ok(!s.includes(CENTER_TOKEN), `token in ${what}`);
    assert.ok(!s.includes(CENTER_PASS), `password in ${what}`);
  };
  const writeSettings = (remote: Record<string, unknown>) => {
    writeFileSync(settingsFile, JSON.stringify({ enabled: false, port: 7910, workspace: "~/.bantou", token: "", remote }), { mode: 0o600 });
  };
  const centerUrlWithUserinfo = () => {
    const u = new URL(center.url);
    u.username = "user";
    u.password = CENTER_PASS;
    return u.href;
  };

  it("新 route も守りの内側: rpc / events / health は 共有鍵なし 403、JWT なし 401、許可外 email 403、POST は Origin 不一致 403", async () => {
    const eve = sign(key, goodClaims({ email: "eve@example.test" }));
    for (const path of ["/api/health", "/api/events"]) {
      assert.equal((await fetch(base + path, { headers: h(jwt(), null) })).status, 403, path);
      assert.equal((await fetch(base + path, { headers: h() })).status, 401, path);
      assert.equal((await fetch(base + path, { headers: h(eve) })).status, 403, path);
    }
    assert.equal((await rpc("center_get_settings", undefined, { jwt: null })).status, 401);
    assert.equal((await rpc("center_get_settings", undefined, { jwt: eve })).status, 403);
    assert.equal((await rpc("center_get_settings", undefined, { origin: "http://evil.example.test" })).status, 403);
    assert.equal((await rpc("center_get_settings", undefined, { origin: null })).status, 403);
    const noKey = await fetch(base + "/api/rpc/center_get_settings", { method: "POST", headers: { ...h(jwt(), null), origin: origin() } });
    assert.equal(noKey.status, 403);
  });

  it("接続先無し（設定 file なし）で起動していて、health が理由を返す", async () => {
    const r = await fetch(base + "/api/health", { headers: h(jwt()) });
    assert.equal(r.status, 200);
    const j = (await r.json()) as { status: string; connected: boolean; reason: string };
    assert.equal(j.status, "no-target");
    assert.equal(j.connected, false);
    assert.ok(j.reason);
    const g = await rpc("center_get_settings");
    assert.equal(g.status, 200);
  });

  it("設定 file を書くと再起動なしで次の呼び出しから向く。health・get_settings に token と userinfo が出ない", async () => {
    writeSettings({ url: centerUrlWithUserinfo(), token: CENTER_TOKEN });
    const hr = await fetch(base + "/api/health", { headers: h(jwt()) });
    const ht = await hr.text();
    noSecret(ht, "health");
    const hj = JSON.parse(ht) as { status: string; host: string; source: string };
    assert.equal(hj.status, "ok");
    assert.equal(hj.host, new URL(center.url).host);
    assert.equal(hj.source, "remote");
    const gt = await (await rpc("center_get_settings")).text();
    noSecret(gt, "center_get_settings");
    const g = JSON.parse(gt) as { token: string; tokenSet?: boolean; remote: { token: string; tokenSet: boolean } };
    assert.equal(g.token, "");
    assert.equal(g.remote.token, "");
    assert.equal(g.remote.tokenSet, true);
  });

  it("rpc: 許可リスト外の command と tool は 404、center_set_settings は拒否", async () => {
    for (const cmd of ["nope", "constructor", "__proto__", "center_status", "center_regenerate_token", "center_local_ips", "session_output_start"]) {
      assert.equal((await rpc(cmd)).status, 404, cmd);
    }
    const before = center.count("tools/call");
    for (const name of ["server_retire", "session_delete"]) {
      assert.equal((await rpc("center_call", { name, arguments: {} })).status, 404, name);
    }
    assert.equal(center.count("tools/call"), before);
    const s = await rpc("center_set_settings", { settings: { enabled: false, port: 7910, workspace: "~", token: "", remote: { url: "http://127.0.0.1:9/mcp", token: "other-token-0123456789" } } });
    assert.equal(s.status, 403);
    noSecret(await s.text(), "set_settings");
    assert.match(readFileSync(settingsFile, "utf8"), /wire-center-token/); // 変わっていない
  });

  it("center の tool 成功本文に token / password があっても応答に出ない。失敗の応答にも出ない", async () => {
    center.tools.set("center_settings_get", { settings: { note: `t=${CENTER_TOKEN} u=http://user:${CENTER_PASS}@127.0.0.1:1/x` } });
    const ok = await rpc("center_call", { name: "center_settings_get" });
    assert.equal(ok.status, 200);
    const okText = await ok.text();
    noSecret(okText, "center_call");
    assert.match(okText, /\*\*\*/);
    center.errorTools.set("rc_list", `bad ${CENTER_TOKEN} ${CENTER_PASS}`);
    const ng = await rpc("center_call", { name: "rc_list" });
    assert.equal(ng.status, 502);
    noSecret(await ng.text(), "center_call error");
  });

  it("session の command（list / refresh / path_hints）が偽 center に届く", async () => {
    center.tools.set("session_list", [{ name: "wire-a", state: "running" }]);
    center.tools.set("center_info", { workspace: "/ws" });
    const l = (await (await rpc("refresh_sessions")).json()) as { sessions: { name: string }[]; reachable: boolean };
    assert.equal(l.reachable, true);
    assert.deepEqual(l.sessions.map((s) => s.name), ["wire-a"]);
    const c = (await (await rpc("list_sessions")).json()) as { sessions: unknown[] };
    assert.equal(c.sessions.length, 1);
    assert.deepEqual(await (await rpc("session_path_hints")).json(), { workspace: "/ws", canPick: false });
  });

  it("SSE: 2 クライアントの両方に center の event と一覧の変化が届く（center への events は 1 本）", async () => {
    const conns: import("node:http").ServerResponse[] = [];
    center.onGet = (req, res) => {
      if (req.url !== "/events") return false;
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(": hi\n\n");
      conns.push(res);
      return true;
    };
    const open = async () => {
      const ac = new AbortController();
      const res = await fetch(base + "/api/events", { headers: h(jwt()), signal: ac.signal });
      assert.equal(res.status, 200);
      assert.match(res.headers.get("content-type") ?? "", /text\/event-stream/);
      assert.equal(res.headers.get("x-accel-buffering"), "no");
      const reader = res.body!.getReader();
      let text = "";
      const until = async (re: RegExp, ms = 8000) => {
        const end = Date.now() + ms;
        while (!re.test(text)) {
          if (Date.now() > end) throw new Error(`SSE に ${re} が来ない: ${JSON.stringify(text)}`);
          const r = await Promise.race([reader.read(), new Promise<null>((r) => setTimeout(() => r(null), 200))]);
          if (r && !r.done) text += new TextDecoder().decode(r.value);
        }
        return text;
      };
      return { until, abort: () => ac.abort() };
    };
    const a = await open();
    const b = await open();
    try {
      await a.until(/^: ok/);
      await b.until(/^: ok/);
      for (let i = 0; i < 100 && conns.length === 0; i++) await new Promise((r) => setTimeout(r, 50));
      assert.equal(conns.length, 1);
      conns[0]!.write('event: sessions\ndata: {"reason":"created","name":"wire-b"}\n\n');
      const want = /event: center-sessions-changed\ndata: \{"reason":"created","name":"wire-b"\}\n\n/;
      await a.until(want);
      await b.until(want);
      center.tools.set("session_list", [{ name: "wire-a" }, { name: "wire-b" }]);
      await rpc("refresh_sessions");
      await a.until(/event: bantou:\/\/sessions-changed\ndata: null\n\n/);
      await b.until(/event: bantou:\/\/sessions-changed\ndata: null\n\n/);
      assert.equal(conns.length, 1);
    } finally {
      a.abort();
      b.abort();
      for (const c of conns) c.end();
    }
  });

  // ---- review: body の上限は読み込み中に守る。超過は assertion（5 秒で無応答なら失敗）で落ちる ----
  const rawPost = (headers: Record<string, string>, chunks: Buffer[], flushOnly = false) =>
    new Promise<{ status: number; body: string }>((resolve, reject) => {
      const u = new URL(base);
      const req = httpRequest(
        { host: u.hostname, port: u.port, path: "/api/rpc/center_get_settings", method: "POST", timeout: 5000,
          headers: { ...h(jwt()), origin: origin(), ...headers } },
        (res) => {
          let b = "";
          res.on("data", (d) => (b += d));
          res.on("end", () => resolve({ status: res.statusCode ?? 0, body: b }));
          if (flushOnly) {
            resolve({ status: res.statusCode ?? 0, body: "" });
            req.destroy();
          }
        },
      );
      req.on("timeout", () => reject(new Error("5 秒たっても応答が無い（body を待っている）")));
      req.on("error", (e) => {
        if (!(flushOnly && (e as NodeJS.ErrnoException).code === "ECONNRESET")) reject(e);
      });
      if (flushOnly) req.flushHeaders();
      else {
        for (const c of chunks) req.write(c);
        req.end();
      }
    });

  it("body 上限: Content-Length が超過なら body を読まずに 413", async () => {
    const r = await rawPost({ "content-length": "400000000" }, [], true);
    assert.equal(r.status, 413);
  });

  it("body 上限: chunked で超過なら受信中に切って 413。上限内は通る", async () => {
    const big = Buffer.alloc(256 * 1024, 97);
    const r = await rawPost({ "transfer-encoding": "chunked" }, [big, big, big, big, big]); // 1.25 MiB
    assert.equal(r.status, 413);
    assert.match(r.body, /大きすぎる/);
    const ok = await rawPost({ "transfer-encoding": "chunked", "content-type": "application/json" }, [Buffer.from("{}")]);
    assert.equal(ok.status, 200);
  });

  it("child の log に token と password が出ていない", () => {
    noSecret(childLog, "server の stdout/stderr");
  });
});
