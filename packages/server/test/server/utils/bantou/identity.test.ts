import { test } from "node:test";
import assert from "node:assert/strict";
import { hostname, userInfo } from "node:os";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { isServerReply, SERVER_ID_PATTERN, MESSENGER_PROTOCOL } from "@agent-hand/bantou-protocol";
import { buildIdentity, generateServerId, loadOrCreateServerId, serverFile } from "../../../../server/utils/bantou/identity";
import { execute } from "../../../../server/utils/bantou/daemon";
import { createUpdateController } from "../../../../server/utils/bantou/update";
import type { AgentManager } from "../../../../server/utils/bantou/agents";

/** 一時 dir は作業 dir（packages/server）の中に作る。 */
async function withWorkspace(fn: (ws: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(process.cwd(), ".tmp-identity-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const readJson = async (p: string): Promise<Record<string, unknown>> => JSON.parse(await readFile(p, "utf8"));

test("generateServerId: SERVER_ID_PATTERN に合う。毎回違う", () => {
  const a = generateServerId();
  assert.match(a, SERVER_ID_PATTERN);
  assert.match(a, /^srv-[0-9a-f]{10}$/);
  assert.notEqual(a, generateServerId());
});

test("初回（server.json が無い）: 生成して保存する", async () => {
  await withWorkspace(async (ws) => {
    const logs: string[] = [];
    const id = await loadOrCreateServerId(ws, (m) => logs.push(m));
    assert.match(id, SERVER_ID_PATTERN);
    const f = await readJson(serverFile(ws));
    assert.equal(f.server_id, id);
    assert.equal(typeof f.created_at, "string");
    assert.ok(logs.some((m) => m.includes("初回")));
  });
});

test("再起動（再読み込み）: 同じ workspace なら server_id は変わらない。ファイルも書き換えない", async () => {
  await withWorkspace(async (ws) => {
    const first = await loadOrCreateServerId(ws);
    const before = await readFile(serverFile(ws), "utf8");
    const logs: string[] = [];
    assert.equal(await loadOrCreateServerId(ws, (m) => logs.push(m)), first);
    assert.equal(await loadOrCreateServerId(ws), first);
    assert.equal(await readFile(serverFile(ws), "utf8"), before);
    assert.deepEqual(logs, []);
  });
});

test("別の workspace は別の server_id", async () => {
  await withWorkspace(async (a) => {
    await withWorkspace(async (b) => {
      assert.notEqual(await loadOrCreateServerId(a), await loadOrCreateServerId(b));
    });
  });
});

test("旧形式（server_id 無しの server.json）: 他のキーを残して server_id を足す", async () => {
  await withWorkspace(async (ws) => {
    await writeFile(serverFile(ws), JSON.stringify({ note: "keep" }));
    const id = await loadOrCreateServerId(ws);
    const f = await readJson(serverFile(ws));
    assert.equal(f.server_id, id);
    assert.equal(f.note, "keep");
    assert.equal(await loadOrCreateServerId(ws), id);
  });
});

test("壊れた server.json（JSON 不正・形が不正・server_id が不正）: 再生成して上書きし、以後は安定", async () => {
  for (const bad of ["{not json", "[]", "null", JSON.stringify({ server_id: "a b" }), JSON.stringify({ server_id: 5 })]) {
    await withWorkspace(async (ws) => {
      await writeFile(serverFile(ws), bad);
      const logs: string[] = [];
      const id = await loadOrCreateServerId(ws, (m) => logs.push(m));
      assert.match(id, SERVER_ID_PATTERN, bad);
      assert.equal((await readJson(serverFile(ws))).server_id, id, bad);
      assert.ok(logs.length === 1, bad);
      assert.equal(await loadOrCreateServerId(ws), id, bad);
    });
  }
});

test("server.json を読めない（dir になっている）: 起動を止めず id を返す。保存できなくても投げない", async () => {
  await withWorkspace(async (ws) => {
    await mkdir(serverFile(ws));
    const logs: string[] = [];
    const id = await loadOrCreateServerId(ws, (m) => logs.push(m));
    assert.match(id, SERVER_ID_PATTERN);
    assert.ok(logs.some((m) => m.includes("保存できない")));
  });
});

test("buildIdentity: server_id / host / user / workspace", () => {
  const i = buildIdentity("srv-0123456789", "/ws");
  assert.deepEqual(i, { server_id: "srv-0123456789", host: hostname(), user: userInfo().username, workspace: "/ws" });
});

test("hello_result: server_id / host / user / workspace / server_version が載る。protocol の検証を通る", async () => {
  const identity = buildIdentity("srv-0123456789", "/ws");
  const controller = createUpdateController({
    workspace: "/nonexistent-ws",
    serverVersion: "0.6.2",
    identity,
    specTemplate: "bantou@{version}",
    running: () => ({ caps: 0, workers: 0, reports: 0 }),
    requestExit: () => {},
    log: () => {},
  });
  const h = controller.hello();
  assert.equal(h.server_id, "srv-0123456789");
  assert.equal(h.host, hostname());
  assert.equal(h.user, userInfo().username);
  assert.equal(h.workspace, "/ws");
  assert.equal(h.server_version, "0.6.2");
  assert.equal(h.protocol_version, MESSENGER_PROTOCOL.version);
  assert.ok(isServerReply(h));
  controller.close();
});

test("hello_result: identity 無し（旧形式）でも protocol の検証を通る", () => {
  const controller = createUpdateController({
    workspace: "/nonexistent-ws",
    serverVersion: "0.6.2",
    specTemplate: "bantou@{version}",
    running: () => ({ caps: 0, workers: 0, reports: 0 }),
    requestExit: () => {},
    log: () => {},
  });
  const h = controller.hello();
  assert.ok(!("server_id" in h));
  assert.ok(isServerReply(h));
  controller.close();
});

test("status_result: identity と server_version / protocol_version が載る。省略時は載らない", async () => {
  const manager = { status: async () => ({ caps: [], workers: [] }) } as unknown as AgentManager;
  const identity = { ...buildIdentity("srv-0123456789", "/ws"), server_version: "0.6.2", protocol_version: MESSENGER_PROTOCOL.version };
  const r = await execute({ bantou: 1, type: "status" }, manager, undefined, identity);
  assert.ok(isServerReply(r));
  assert.deepEqual(r, { bantou: 1, type: "status_result", ok: true, ...identity, caps: [], workers: [] });
  const old = await execute({ bantou: 1, type: "status" }, manager);
  assert.deepEqual(old, { bantou: 1, type: "status_result", ok: true, caps: [], workers: [] });
  assert.ok(isServerReply(old));
});
