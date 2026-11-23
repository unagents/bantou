import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createClientKeys, createRangeCheck, ensureInternalToken, KEY_PATH, parseRange } from "../src/client-keys.js";
import { parseConfig } from "../src/config.js";
import { startHttpServer } from "../src/http.js";
import { assertPortFree, PortInUseError } from "../src/port-check.js";

const TOKEN = "t".repeat(16);

async function tmp(): Promise<string> {
  return mkdtemp(join(tmpdir(), "bantou-keys-"));
}

test("parseRange: IP・CIDR の書式を見分ける", () => {
  assert.ok(parseRange("192.168.1.0/24"));
  assert.ok(parseRange("10.0.0.5"));
  assert.ok(parseRange("fd00::/8"));
  assert.equal(parseRange("192.168.1.0/33"), undefined);
  assert.equal(parseRange("abc"), undefined);
  assert.equal(parseRange("10.0.0.0/x"), undefined);
  assert.equal(parseRange("10.0.0.0/8/8"), undefined);
});

test("createRangeCheck: 範囲の中だけ true。空の範囲・不明な接続元は false。IPv4-mapped も見る", () => {
  const inRange = createRangeCheck(["192.168.1.0/24", "10.0.0.5", "fd00::/8"]);
  assert.equal(inRange("192.168.1.77"), true);
  assert.equal(inRange("::ffff:192.168.1.77"), true);
  assert.equal(inRange("10.0.0.5"), true);
  assert.equal(inRange("fd12::1"), true);
  assert.equal(inRange("192.168.2.1"), false);
  assert.equal(inRange("10.0.0.6"), false);
  assert.equal(inRange(undefined), false);
  assert.equal(inRange("not-an-ip"), false);
  assert.equal(createRangeCheck([])("127.0.0.1"), false);
  assert.throws(() => createRangeCheck(["bad"]), /IP の範囲が不正/);
});

test("config: port・keyRanges を読む。不正な値は config error", () => {
  const c = parseConfig({ port: 7911, keyRanges: ["192.168.1.0/24"] }, "/c.json");
  assert.equal(c.port, 7911);
  assert.deepEqual(c.keyRanges, ["192.168.1.0/24"]);
  const d = parseConfig({}, "/c.json");
  assert.equal(d.port, undefined);
  assert.equal(d.keyRanges, undefined);
  assert.throws(() => parseConfig({ port: 70000 }, "/c.json"), /config が不正/);
  assert.throws(() => parseConfig({ keyRanges: ["x"] }, "/c.json"), /keyRanges/);
});

test("createClientKeys: 発行した鍵だけ通り、再起動後も通る。file には hash だけ（0600）", async () => {
  const dir = await tmp();
  try {
    const file = join(dir, "client-keys.json");
    const a = await createClientKeys(file, () => {});
    const k1 = await a.issue();
    const k2 = await a.issue();
    assert.notEqual(k1, k2);
    assert.equal(a.verify(`Bearer ${k1}`), true);
    assert.equal(a.verify(`Bearer ${k2}`), true);
    assert.equal(a.verify("Bearer nope"), false);
    assert.equal(a.verify(k1), false);
    assert.equal(a.verify(undefined), false);
    const raw = await readFile(file, "utf8");
    assert.ok(!raw.includes(k1));
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    const b = await createClientKeys(file, () => {});
    assert.equal(b.verify(`Bearer ${k1}`), true);
    assert.equal(b.verify("Bearer nope"), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("ensureInternalToken: 1 度作り、以後は同じ値（0600）", async () => {
  const dir = await tmp();
  try {
    const file = join(dir, "sub", "internal-token");
    const t1 = await ensureInternalToken(file);
    assert.ok(t1.length >= 12);
    assert.equal(await ensureInternalToken(file), t1);
    assert.equal((await stat(file)).mode & 0o777, 0o600);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

async function bootKeys(ranges: string[], dir: string) {
  const clientKeys = await createClientKeys(join(dir, "client-keys.json"), () => {});
  const logs: string[] = [];
  const h = await startHttpServer({
    createServer: () => {
      throw new Error("unused");
    },
    graphql: async (_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"data":{"ok":true}}');
    },
    clientKeys,
    keyRange: createRangeCheck(ranges),
    port: 0,
    bind: "127.0.0.1",
    token: TOKEN,
    log: (m) => logs.push(m),
  });
  return { h, base: `http://127.0.0.1:${h.port}`, logs };
}

test("鍵を取る接続: 範囲内なら鍵を渡し、その鍵で外向けの経路が通る。鍵の無い通信は 401", async () => {
  const dir = await tmp();
  const { h, base, logs } = await bootKeys(["127.0.0.0/8"], dir);
  try {
    const gql = (auth?: string) => fetch(`${base}/graphql`, { method: "POST", headers: auth ? { authorization: auth } : {}, body: "{}" });
    assert.equal((await gql()).status, 401);
    assert.equal((await gql("Bearer nope")).status, 401);
    const r = await fetch(`${base}${KEY_PATH}`, { method: "POST" });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("cache-control"), "no-store");
    const { key } = (await r.json()) as { key: string };
    assert.ok(key.length >= 32);
    assert.equal((await gql(`Bearer ${key}`)).status, 200);
    // 今の token も通る（desktop が起動時に渡す形 (a)）
    assert.equal((await gql(`Bearer ${TOKEN}`)).status, 200);
    assert.ok(logs.some((l) => l.includes("鍵を渡した")));
    assert.ok(logs.every((l) => !l.includes(key)));
  } finally {
    await h.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("鍵を取る接続: 範囲の外・範囲が空なら 403 で鍵を渡さない。POST 以外は 405", async () => {
  const dir = await tmp();
  const out = await bootKeys(["192.168.77.0/24"], dir);
  const empty = await bootKeys([], dir);
  try {
    for (const { base } of [out, empty]) {
      const r = await fetch(`${base}${KEY_PATH}`, { method: "POST" });
      assert.equal(r.status, 403);
      assert.ok(!(await r.text()).includes("key"));
    }
    assert.equal((await fetch(`${out.base}${KEY_PATH}`)).status, 405);
    assert.ok(out.logs.some((l) => l.includes("鍵を渡さない")));
  } finally {
    await out.h.close();
    await empty.h.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("clientKeys を渡さない起動は KEY_PATH を持たない（404）", async () => {
  const h = await startHttpServer({ createServer: () => { throw new Error("unused"); }, port: 0, bind: "127.0.0.1", token: TOKEN, log: () => {} });
  try {
    assert.equal((await fetch(`http://127.0.0.1:${h.port}${KEY_PATH}`, { method: "POST" })).status, 404);
  } finally {
    await h.close();
  }
});

test("assertPortFree: 空きなら通り、使用中は理由つきで PortInUseError（center か他の program かを見分ける）", async () => {
  await assertPortFree(0, "127.0.0.1");
  // 他の program（HTTP でない接続だけできる）
  const other = createServer((s) => s.destroy());
  await new Promise<void>((r) => other.listen(0, "127.0.0.1", r));
  const otherPort = (other.address() as { port: number }).port;
  // center（/graphql が 401 + www-authenticate: Bearer）
  const dir = await tmp();
  const { h, base } = await bootKeys([], dir);
  const centerPort = Number(new URL(base).port);
  try {
    await assert.rejects(assertPortFree(otherPort, "127.0.0.1", 500), (e: unknown) => e instanceof PortInUseError && /他の program/.test((e as Error).message) && (e as Error).message.includes(String(otherPort)));
    await assert.rejects(
      assertPortFree(centerPort, "127.0.0.1", 500),
      (e: unknown) => e instanceof PortInUseError && /既に center が動いている/.test((e as Error).message),
    );
  } finally {
    await h.close();
    await new Promise<void>((r) => other.close(() => r()));
    await rm(dir, { recursive: true, force: true });
  }
  // 閉じた後は空く
  await assertPortFree(centerPort, "127.0.0.1");
});
