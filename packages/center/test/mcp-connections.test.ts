import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { runMcpCli } from "../src/mcp-cli.js";
import { composeConnection, validateAll, validateConnection, visibleToolNames, parseConnections, type McpConnection } from "../src/mcp-connections.js";
import { closedPortUrl, startFakeRelay, type FakeRelay } from "./helpers/fake-relay.js";

const SECRET = "SeCr3t-Value_9f8e7d6c5b4a3210";
let dir: string;
let config: string;
const transcript: string[] = []; // 全 command の出力（標準出力・標準エラー）。鍵が出ていない事の検索に使う
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "center-mcp-"));
  config = join(dir, "state", "center.json");
  transcript.length = 0;
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const run = async (argv: string[], stdin = "", files: Record<string, string> = {}) => {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runMcpCli([argv[0], ...argv.slice(1), "--config", config], "/nonexistent/default.json", {
    readStdin: () => stdin,
    readFile: (p) => {
      if (!(p in files)) throw new Error("ENOENT");
      return files[p];
    },
    out: (l) => out.push(l),
    err: (l) => err.push(l),
  });
  transcript.push(...out, ...err);
  return { code, out: out.join("\n"), err: err.join("\n") };
};
const state = (f: string) => join(dir, "state", f);
const readJson = async (f: string) => JSON.parse(await readFile(state(f), "utf8"));

/** 状態 dir の全 file（鍵の file を除く）と全出力に、鍵が無い事。 */
async function assertNoSecretLeak(secret = SECRET): Promise<void> {
  for (const l of transcript) assert.ok(!l.includes(secret), `出力に鍵が出た: ${l.slice(0, 60)}`);
  for (const f of await readdir(join(dir, "state")).catch(() => [] as string[])) {
    if (f.startsWith("mcp-secrets.json")) continue;
    assert.ok(!(await readFile(state(f), "utf8")).includes(secret), `${f} に鍵が出た`);
  }
}

const base = { transport: "http", url: "https://relay.example/mcp" } as const;

describe("検証", () => {
  test("予約の名前は断る（center が組み立てる物と口の path）", async () => {
    for (const n of ["bantou", "bantou-messenger", "mcp", "conn"]) {
      const r = await run(["set", n, "--url", "https://relay.example/mcp"]);
      assert.equal(r.code, 2, n);
      assert.match(r.err, /予約/);
    }
    assert.equal((await run(["set", "Memory", "--url", "https://relay.example/mcp"])).code, 2, "大文字");
    assert.equal((await run(["set", "memory", "--url", "https://relay.example/mcp"])).code, 0);
  });

  test("形の崩れた URL は断り、何も書かない", async () => {
    const bad = ["relay.example/mcp", "ftp://relay.example/mcp", "https://relay.example/ mcp", "https://u:p@relay.example/mcp", "https://relay.example/${HOME}", "not a url", "https://relay.example/mcp?token=abc", "https://relay.example/mcp?API_KEY=abc"];
    for (const u of bad) {
      const r = await run(["set", "relay", "--url", u]);
      assert.equal(r.code, 2, u);
      assert.ok(!r.err.includes("abc"), "値を出さない");
    }
    await assert.rejects(stat(state("mcp-connections.json")));
  });

  test("鍵を付ける接続で http: の公の host は --allow-plain-http が要る。LAN の address は要らない", async () => {
    assert.equal((await run(["set", "pub", "--url", "http://relay.example/mcp", "--secret", "k"])).code, 2);
    assert.equal((await run(["set", "pub", "--url", "http://relay.example/mcp", "--secret", "k", "--allow-plain-http"])).code, 0);
    for (const h of ["127.0.0.1", "10.1.2.3", "192.168.0.5", "172.16.0.1", "localhost", "[::1]"]) {
      assert.equal((await run(["set", "lan", "--url", `http://${h}:8080/mcp`, "--secret", "k"])).code, 0, h);
    }
    assert.equal((await run(["set", "pub2", "--url", "http://relay.example/mcp"])).code, 0, "鍵なしなら断らない");
  });

  test("auth.format は {secret} をちょうど 1 つ。${ と改行は不可", async () => {
    for (const f of ["Bearer", "{secret}{secret}", "Bearer ${X} {secret}", "Bearer {secret}\r\nX: y"]) {
      assert.equal((await run(["set", "r1", "--url", "https://relay.example/mcp", "--secret", "k", "--auth-format", f])).code, 2, JSON.stringify(f));
    }
    assert.equal((await run(["set", "r1", "--url", "https://relay.example/mcp", "--secret", "k", "--auth-format", "{secret}"])).code, 0);
  });

  test("固定の header: 鍵らしい名前・鍵や識別と同じ名前・改行・11 個目は不可", async () => {
    const u = ["set", "r2", "--url", "https://relay.example/mcp"];
    assert.equal((await run([...u, "--header", "X-Api-Key=1"])).code, 2);
    assert.equal((await run([...u, "--header", "Cookie=a=b"])).code, 2);
    assert.equal((await run([...u, "--secret", "k", "--auth-header", "X-Relay", "--header", "x-relay=1"])).code, 2, "鍵の header と同名");
    assert.equal((await run([...u, "--identity-header", "X-Agent-Id", "--header", "x-agent-id=1"])).code, 2, "識別の header と同名");
    assert.equal((await run([...u, "--header", "X-Server=a\nb"])).code, 2);
    const many = Array.from({ length: 11 }, (_, i) => ["--header", `X-H${i}=v`]).flat();
    assert.equal((await run([...u, ...many])).code, 2);
    assert.equal((await run([...u, "--header", "X-Server=memory"])).code, 0);
  });

  test("役割 memory は 1 つまで（共通と session の合成後）", async () => {
    assert.equal((await run(["set", "memory", "--url", "https://relay.example/mcp", "--role", "memory"])).code, 0);
    const dup = await run(["set", "second", "--url", "https://relay.example/mcp2", "--role", "memory"]);
    assert.equal(dup.code, 2);
    assert.match(dup.err, /role memory/);
    // session の上書きで 2 つ目の役割 memory を作るのも断る
    assert.equal((await run(["set", "second", "--url", "https://relay.example/mcp2"])).code, 0);
    const viaSession = await run(["set", "second", "--session", "s1", "--role", "memory"]);
    assert.equal(viaSession.code, 2);
    assert.match(viaSession.err, /role memory/);
    // session で memory の役割を外してから second に付けるのは通る
    assert.equal((await run(["set", "memory", "--session", "s1", "--no-role"])).code, 0);
    assert.equal((await run(["set", "second", "--session", "s1", "--role", "memory"])).code, 0);
  });

  test("validateAll / validateConnection は入力値を含まない文を返す", () => {
    const r = validateConnection({ ...base, url: "https://relay.example/mcp?token=LEAKME", headers: { "X-Api-Key": "LEAKME2" } });
    assert.equal(r.ok, false);
    assert.ok(!JSON.stringify(r).includes("LEAKME"));
    const data = parseConnections({ version: 1, common: { a: { ...base, role: "memory" }, b: { ...base, role: "memory" } }, sessions: {} }).data;
    assert.equal(validateAll(data).length, 1);
  });

  test("session の上書きは項目ごと。null は外す。入れ子は丸ごと置き換え", () => {
    const common: McpConnection = { ...base, auth: { header: "X-Relay", format: "{secret}" }, identity: { header: "X-Agent-Id" }, role: "memory" };
    const c = composeConnection(common, { identity: { header: "X-Agent-Id", value: "agent1" }, role: null, auth: { secret: "other" } });
    assert.deepEqual(c, { ...base, auth: { secret: "other" }, identity: { header: "X-Agent-Id", value: "agent1" } });
    assert.equal(composeConnection(common, null), undefined);
  });

  test("見える道具: 前置きで絞って剥がす。前置きの無い物は外す。memory は event を見せない。deny が勝つ", () => {
    const names = ["memory-event", "memory-recall", "memory-context", "search-find", "recall", "memory-"];
    const c = { ...base, toolPrefix: "memory-", role: "memory" } as McpConnection;
    assert.deepEqual(visibleToolNames(c, names), ["recall", "context"]);
    assert.deepEqual(visibleToolNames({ ...c, exposeMemoryWrite: true }, names), ["event", "recall", "context"]);
    assert.deepEqual(visibleToolNames({ ...base, tools: { allow: ["search-*", "recall"], deny: ["search-find"] } } as McpConnection, names), ["recall"]);
    assert.deepEqual(visibleToolNames({ ...base } as McpConnection, ["ok_name", "bad name", "x".repeat(65)]), ["ok_name"]);
  });
});

describe("設定・鍵の読み書きと権限", () => {
  test("set / get / list / unset の往復（共通・session の上書き・--off）", async () => {
    const a = ["set", "relay", "--url", "https://relay.example/mcp?x=1", "--secret", "k1", "--auth-header", "X-Relay", "--auth-format", "{secret}", "--header", "X-Server=memory", "--identity-header", "X-Agent-Id", "--tool-prefix", "memory-", "--allow", "recall", "--deny", "event", "--timeout-ms", "5000"];
    assert.equal((await run(a)).code, 0);
    const get = await run(["get", "relay"]);
    assert.match(get.out, /url=https:\/\/relay\.example\/mcp\?…/, "query は伏せる");
    assert.ok(!get.out.includes("x=1"));
    assert.match(get.out, /headers=X-Server（値は出さない）/);
    assert.ok(!get.out.includes("memory\n") && !/X-Server=memory/.test(get.out));
    assert.match(get.out, /鍵 k1: 未設定/);
    assert.equal((await run(["secret", "set", "k1", "--stdin"], `${SECRET}\n`)).code, 0);
    assert.match((await run(["get", "relay"])).out, /鍵 k1: 設定済み rev 1/);
    assert.equal((await run(["secret", "set", "k1", "--stdin"], SECRET)).code, 0);
    assert.match((await run(["secret", "list"])).out, /k1: rev 2 .* 使っている接続: relay/);

    // session の上書き（識別の値だけ）と --off
    assert.equal((await run(["set", "relay", "--session", "s1", "--identity", "agent-1"])).code, 0);
    const sget = await run(["get", "relay", "--session", "s1"]);
    assert.match(sget.out, /identity=X-Agent-Id=agent-1/);
    assert.match(sget.out, /url=https:\/\/relay\.example\/mcp/, "上書きしていない項目は共通のまま");
    assert.equal((await run(["set", "relay", "--session", "s2", "--off"])).code, 0);
    assert.match((await run(["get", "relay", "--session", "s2"])).out, /この session では付けない[\s\S]*有効な接続: なし/);
    const list = await run(["list"]);
    assert.match(list.out, /全 session 共通:[\s\S]*relay:/);
    assert.match(list.out, /session s2 の上書き: relay\(付けない\)/);
    // 共通を消そうとすると上書きが残っているので断る
    assert.equal((await run(["unset", "relay"])).code, 1);
    assert.equal((await run(["unset", "relay", "--session", "s1"])).code, 0);
    assert.equal((await run(["unset", "relay", "--session", "s2"])).code, 0);
    assert.equal((await run(["unset", "relay"])).code, 0);
    assert.deepEqual((await readJson("mcp-connections.json")).common, {});
    assert.equal((await run(["secret", "unset", "k1"])).code, 0);
    assert.match((await run(["secret", "list"])).out, /鍵なし/);
    await assertNoSecretLeak();
  });

  test("file は 0600、状態 dir は新しく作る時 0700、鍵は別 file", async () => {
    await run(["set", "relay", "--url", "https://relay.example/mcp", "--secret", "k1"]);
    await run(["secret", "set", "k1", "--stdin"], SECRET);
    const relay = await startFakeRelay({ secret: SECRET });
    try {
      await run(["set", "t", "--url", relay.url, "--secret", "k1"]);
      await run(["test", "t"]);
    } finally {
      await relay.close();
    }
    for (const f of ["mcp-connections.json", "mcp-secrets.json", "mcp-status.json"]) assert.equal((await stat(state(f))).mode & 0o777, 0o600, f);
    assert.equal((await stat(join(dir, "state"))).mode & 0o777, 0o700);
    assert.ok(!(await readFile(state("mcp-connections.json"), "utf8")).includes(SECRET), "接続の file に鍵は無い");
    assert.ok((await readFile(state("mcp-secrets.json"), "utf8")).includes(SECRET));
    assert.equal((await readdir(join(dir, "state"))).filter((f) => f.endsWith(".tmp")).length, 0, "一時 file は残らない");
  });

  test("壊れた接続の file には書かない", async () => {
    await run(["set", "relay", "--url", "https://relay.example/mcp"]);
    const { writeFile } = await import("node:fs/promises");
    await writeFile(state("mcp-connections.json"), "{ not json");
    const r = await run(["set", "other", "--url", "https://relay.example/mcp"]);
    assert.equal(r.code, 1);
    assert.equal(await readFile(state("mcp-connections.json"), "utf8"), "{ not json");
  });
});

describe("鍵が出ない", () => {
  test("引数に書かれた鍵は値を出さずに断る（--value / --token / = 形 / 位置引数）", async () => {
    for (const argv of [
      ["secret", "set", "k1", "--value", SECRET],
      ["secret", "set", "k1", `--value=${SECRET}`],
      ["secret", "set", "k1", "--token", SECRET],
      ["set", "relay", "--url", "https://relay.example/mcp", `--password=${SECRET}`],
      ["secret", "set", "k1", SECRET, "--stdin"],
      ["set", "relay", `--key=${SECRET}`],
      ["set", "relay", `--no-such-flag=${SECRET}`],
    ]) {
      const r = await run(argv, SECRET);
      assert.notEqual(r.code, 0, argv.join(" ").replace(SECRET, "***"));
      assert.ok(!r.out.includes(SECRET) && !r.err.includes(SECRET));
    }
    await assert.rejects(stat(state("mcp-secrets.json")), "鍵は保存されない");
    await assertNoSecretLeak();
  });

  test("不正な鍵（空白・非 ASCII・長すぎ・空）は断り、値を出さない", async () => {
    for (const bad of ["has space inside", "日本語の鍵", "x".repeat(4097), "", "tab\there"]) {
      const r = await run(["secret", "set", "k1", "--stdin"], bad);
      assert.equal(r.code, 2);
      assert.ok(bad === "" || !r.err.includes(bad));
    }
    const r = await run(["secret", "set", "k1", "--file", "/no/such"]);
    assert.equal(r.code, 1);
    assert.equal((await run(["secret", "set", "k1", "--file", "/p"], "", { "/p": `${SECRET}\r\n` })).code, 0);
    assert.equal((await readJson("mcp-secrets.json")).secrets.k1.value, SECRET, "末尾の改行は除く");
  });

  test("全 command の出力・log・状態 file（鍵の file を除く）に鍵が出ない。鍵が URL に混ざった設定も", async () => {
    const relay = await startFakeRelay({ secret: SECRET, authHeader: "x-relay-key", authFormat: "raw" });
    try {
      await run(["set", "relay", "--url", relay.url, "--secret", "k1", "--auth-header", "X-Relay-Key", "--auth-format", "{secret}"]);
      await run(["secret", "set", "k1", "--stdin"], SECRET);
      await run(["set", "leaky", "--url", `${relay.url}?token=${SECRET}`]); // 断られる。値は出ない
      await run(["set", "relay", "--session", "s1", "--header", `X-Note=${SECRET}`]); // 値は保存されうるが、表示には出ない
      for (const a of [["list"], ["list", "--session", "s1"], ["get", "relay"], ["get", "relay", "--session", "s1"], ["secret", "list"], ["test", "relay"], ["test", "relay", "--json"], ["test", "relay", "--session", "s1"]]) await run(a);
      const wrong = await startFakeRelay({ secret: "another" });
      await run(["set", "bad", "--url", wrong.url, "--secret", "k1"]);
      const t = await run(["test", "bad"]);
      assert.equal(t.code, 1);
      await wrong.close();
    } finally {
      await relay.close();
    }
    for (const l of transcript) assert.ok(!l.includes(SECRET));
    // X-Note の値を除き（利用者が固定の header に書いた物は設定 file にはある）、他の file は…
    assert.ok(!(await readFile(state("mcp-status.json"), "utf8")).includes(SECRET));
    assert.ok(!(await readFile(state("mcp-secrets.json"), "utf8")).includes("leaky"));
  });
});

describe("試す", () => {
  let relay: FakeRelay | undefined;
  afterEach(async () => {
    await relay?.close();
    relay = undefined;
  });

  const cases: Array<{ label: string; authHeader: string; authFormat: "bearer" | "raw"; flags: string[] }> = [
    { label: "Authorization: Bearer", authHeader: "authorization", authFormat: "bearer", flags: [] },
    { label: "独自の header に Bearer", authHeader: "x-relay-auth", authFormat: "bearer", flags: ["--auth-header", "X-Relay-Auth"] },
    { label: "独自の header に値そのまま", authHeader: "x-relay-key", authFormat: "raw", flags: ["--auth-header", "X-Relay-Key", "--auth-format", "{secret}"] },
  ];
  for (const c of cases) {
    test(`3 つの鍵の形で一覧が取れる: ${c.label}`, async () => {
      relay = await startFakeRelay({ secret: SECRET, authHeader: c.authHeader, authFormat: c.authFormat, pageSize: 2 });
      await run(["secret", "set", "relay", "--stdin"], SECRET);
      await run(["set", "relay", "--url", relay.url, "--secret", "relay", "--header", "X-Server=memory", ...c.flags]);
      const r = await run(["test", "relay"]);
      assert.equal(r.code, 0, r.err + r.out);
      assert.match(r.out, /relay（全 session 共通）: ok/);
      assert.match(r.out, /先の server: fake-relay 0\.0\.1/);
      assert.match(r.out, /道具の数: 6（session に見える: 6）/, "ページを辿る");
      assert.deepEqual(relay.toolCalls, [], "道具は呼ばない");
      const rec = relay.requests.find((q) => q.rpcMethod === "tools/list");
      assert.equal(rec?.headers["x-server"], "memory", "固定の header が届く");
      await assertNoSecretLeak();
      const st = (await readJson("mcp-status.json")).results["common/relay"];
      assert.equal(st.result, "ok");
      assert.equal(st.toolCount, 6);
      assert.equal(st.toolsCopy.length, 6);
      assert.equal(st.toolsCopy[0].inputSchema.type, "object", "先の一覧そのもの");
      assert.match(st.configHash, /^[0-9a-f]{32}$/);
    });
  }

  test("鍵が違うと auth（HTTP 401）。exit 1。結果を残す", async () => {
    relay = await startFakeRelay({ secret: "right" });
    await run(["secret", "set", "relay", "--stdin"], "wrong");
    await run(["set", "relay", "--url", relay.url, "--secret", "relay"]);
    const r = await run(["test", "relay"]);
    assert.equal(r.code, 1);
    assert.match(r.out, /relay（全 session 共通）: auth/);
    assert.match(r.out, /HTTP status: 401/);
    assert.equal((await readJson("mcp-status.json")).results["common/relay"].result, "auth");
  });

  test("分類: 403 = auth、404 = not-found、503 = unreachable、壊れた応答 = protocol、落ちている = unreachable、遅い = timeout", async () => {
    relay = await startFakeRelay({ secret: SECRET, slowMs: 4000 });
    await run(["secret", "set", "relay", "--stdin"], SECRET);
    await run(["set", "relay", "--url", relay.url, "--secret", "relay", "--timeout-ms", "1000"]);
    const expectations: Array<[typeof relay.mode, string, number | null]> = [
      ["forbidden", "auth", 403],
      ["notfound", "not-found", 404],
      ["unavailable", "unreachable", 503],
      ["broken", "protocol", null],
      ["drop", "unreachable", null],
      ["slow", "timeout", null],
    ];
    for (const [mode, want, http] of expectations) {
      relay.mode = mode;
      const r = await run(["test", "relay", "--json"]);
      const j = JSON.parse(r.out);
      assert.equal(j.result, want, mode);
      assert.equal(j.httpStatus, http, mode);
      assert.equal(r.code, 1, mode);
    }
    // 落ちている（待ち受けが無い port）
    await run(["set", "down", "--url", await closedPortUrl()]);
    const d = JSON.parse((await run(["test", "down", "--json"])).out);
    assert.equal(d.result, "unreachable");
    assert.ok(d.durationMs < 5000);
    await assertNoSecretLeak();
  });

  test("鍵が未設定なら config-error（先へ接続しない）", async () => {
    relay = await startFakeRelay({ secret: SECRET });
    await run(["set", "relay", "--url", relay.url, "--secret", "nokey"]);
    const r = await run(["test", "relay"]);
    assert.equal(r.code, 1);
    assert.match(r.out, /config-error/);
    assert.equal(relay.requests.length, 0);
  });

  test("接続が無い・使い方の誤りは exit 2", async () => {
    assert.equal((await run(["test", "nope"])).code, 2);
    assert.equal((await run(["test"])).code, 2);
    assert.equal((await run(["frobnicate"])).code, 2);
    assert.equal((await run(["get", "x", "--url", "https://relay.example/mcp"])).code, 2, "get に set の flag");
  });

  test("識別の header: 既定は bantou-center-test、--session ならその値。外部記憶（役割 memory）の event は呼ばない", async () => {
    relay = await startFakeRelay({ secret: SECRET });
    await run(["secret", "set", "memory", "--stdin"], SECRET);
    await run(["set", "memory", "--url", relay.url, "--secret", "memory", "--identity-header", "X-Agent-Id", "--tool-prefix", "memory-", "--role", "memory"]);
    const r = await run(["test", "memory"]);
    assert.equal(r.code, 0);
    assert.match(r.out, /event（前置き込み）が先にある/);
    assert.match(r.out, /session に見える名前: mcp__memory__recall, mcp__memory__context$/m, "前置きを剥がし、event は見せない");
    assert.equal(relay.requests.find((q) => q.rpcMethod === "tools/list")?.headers["x-agent-id"], "bantou-center-test");
    await run(["test", "memory", "--session", "alice"]);
    const last = [...relay.requests].reverse().find((q) => q.rpcMethod === "tools/list");
    assert.equal(last?.headers["x-agent-id"], "alice");
    assert.deepEqual(relay.toolCalls, [], "event を呼ばない");
    // 役割 memory の set は、この版では使われない旨を出す
    assert.match((await run(["set", "memory", "--timeout-ms", "2000"])).out, /まだ外部記憶には使わない/);
  });

  test("session ごとの上書きを当てて試す（識別の値）", async () => {
    relay = await startFakeRelay({ secret: SECRET });
    await run(["secret", "set", "relay", "--stdin"], SECRET);
    await run(["set", "relay", "--url", relay.url, "--secret", "relay", "--identity-header", "X-Agent-Id"]);
    await run(["set", "relay", "--session", "bob", "--identity", "agent-bob"]);
    assert.equal((await run(["test", "relay", "--session", "bob"])).code, 0);
    const q = [...relay.requests].reverse().find((x) => x.rpcMethod === "tools/list");
    assert.equal(q?.headers["x-agent-id"], "agent-bob");
    assert.ok((await readJson("mcp-status.json")).results["bob/relay"]);
  });
});
