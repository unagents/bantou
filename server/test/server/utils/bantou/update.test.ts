import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  UpdateError,
  buildSpec,
  createUpdateController,
  fetchCommand,
  readUpdateFile,
  removeReadyFile,
  verifyFetch,
  writeReadyFile,
  writeUpdateFile,
  type UpdateControllerDeps,
} from "../../../../server/utils/bantou/update";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function withDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "bantou-update-test-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("buildSpec: {version} を置き換える（複数でも）", () => {
  assert.equal(buildSpec("bantou@{version}", "0.3.1"), "bantou@0.3.1");
  assert.equal(buildSpec("file:/t/b-{version}/x-{version}.tgz", "0.0.0-e2e.2"), "file:/t/b-0.0.0-e2e.2/x-0.0.0-e2e.2.tgz");
});

test("fetchCommand: npx -y --package=<spec> -- bantou --version", () => {
  assert.deepEqual(fetchCommand("bantou@0.3.1"), {
    cmd: "npx",
    args: ["-y", "--package=bantou@0.3.1", "--", "bantou", "--version"],
  });
});

test("verifyFetch: 出力の最終行が要求の版なら成功、違う・失敗は update_failed", async () => {
  const calls: string[][] = [];
  await verifyFetch("bantou@0.3.1", "0.3.1", async (cmd, args) => {
    calls.push([cmd, ...args]);
    return { stdout: "npm warn x\n0.3.1\n" };
  });
  assert.deepEqual(calls[0], ["npx", "-y", "--package=bantou@0.3.1", "--", "bantou", "--version"]);
  await assert.rejects(
    verifyFetch("bantou@0.3.1", "0.3.1", async () => ({ stdout: "0.2.3\n" })),
    (e: unknown) => e instanceof UpdateError && e.code === "update_failed" && e.retryable === false && /0\.2\.3/.test(e.message),
  );
  await assert.rejects(
    verifyFetch("bantou@9.9.9", "9.9.9", async () => {
      throw new Error("404 Not Found");
    }),
    (e: unknown) => e instanceof UpdateError && e.code === "update_failed" && /404/.test(e.message),
  );
});

test("update.json / server.ready: 読み書き", async () => {
  await withDir(async (dir) => {
    assert.equal(await readUpdateFile(dir), undefined);
    await writeUpdateFile(dir, { state: "restart", to: "0.3.1", spec: "bantou@0.3.1" });
    assert.deepEqual(await readUpdateFile(dir), { state: "restart", to: "0.3.1", spec: "bantou@0.3.1" });
    await writeUpdateFile(dir, { state: "failed", to: "0.3.1", error: "x", at: "2026-10-31T00:00:00.000Z" });
    assert.equal((await readUpdateFile(dir))?.state, "failed");
    await writeFile(join(dir, "update.json"), "{broken");
    assert.equal(await readUpdateFile(dir), undefined);
    await writeReadyFile(dir, "0.3.0");
    assert.deepEqual(JSON.parse(await readFile(join(dir, "server.ready"), "utf8")), { pid: process.pid, version: "0.3.0" });
    await removeReadyFile(dir);
    await assert.rejects(stat(join(dir, "server.ready")));
    // 他 pid の ready は消さない
    await writeFile(join(dir, "server.ready"), JSON.stringify({ pid: process.pid + 1, version: "x" }));
    await removeReadyFile(dir);
    await stat(join(dir, "server.ready"));
  });
});

interface Harness {
  deps: UpdateControllerDeps;
  running: { caps: number; workers: number; reports: number };
  exits: string[];
  fetched: string[];
  logs: string[];
}

function harness(dir: string, over: Partial<UpdateControllerDeps> = {}): Harness {
  const h: Harness = { deps: undefined as never, running: { caps: 0, workers: 0, reports: 0 }, exits: [], fetched: [], logs: [] };
  h.deps = {
    workspace: dir,
    serverVersion: "0.3.0",
    specTemplate: "bantou@{version}",
    running: () => ({ ...h.running }),
    fetch: async (spec, version) => {
      h.fetched.push(`${spec}|${version}`);
    },
    requestExit: (r) => h.exits.push(r),
    log: (m) => h.logs.push(m),
    pollMs: 10,
    ...over,
  };
  return h;
}

test("hello: 版と protocol 版、更新なしは null", async () => {
  await withDir(async (dir) => {
    const c = createUpdateController(harness(dir).deps);
    const r = c.hello();
    assert.equal(r.type, "hello_result");
    assert.equal(r.server_version, "0.3.0");
    assert.equal(r.protocol_version, "1.3.0");
    assert.equal(r.update, null);
    assert.equal(r.last_update, null);
    assert.equal(c.isUpdating(), false);
    c.close();
  });
});

test("request: 不正な版は invalid_version、同じ版は current", async () => {
  await withDir(async (dir) => {
    const h = harness(dir);
    const c = createUpdateController(h.deps);
    for (const v of ["", "latest", "-1.0.0", "1.0"]) {
      await assert.rejects(c.request(v), (e: unknown) => e instanceof UpdateError && e.code === "invalid_version", v);
    }
    const r = await c.request("0.3.0");
    assert.equal(r.state, "current");
    assert.deepEqual(h.fetched, []);
    assert.equal(c.isUpdating(), false);
    c.close();
  });
});

test("request: 実行中があれば waiting（すぐ返る）、全部終わったら update.json を書いて終了を頼む", async () => {
  await withDir(async (dir) => {
    const h = harness(dir);
    h.running = { caps: 1, workers: 2, reports: 0 };
    const c = createUpdateController(h.deps);
    const r = await c.request("0.3.1");
    assert.equal(r.state, "waiting");
    assert.equal(r.from, "0.3.0");
    assert.equal(r.to, "0.3.1");
    assert.deepEqual(r.running, { caps: 1, workers: 2, reports: 0 });
    assert.deepEqual(h.fetched, ["bantou@0.3.1|0.3.1"]);
    assert.equal(c.isUpdating(), true);
    assert.equal(c.hello().update?.state, "waiting");
    // 待機中: 終了しない
    await sleep(60);
    assert.deepEqual(h.exits, []);
    assert.equal(await readUpdateFile(dir), undefined);
    // cap が終わっても worker が残る間は待つ
    h.running = { caps: 0, workers: 1, reports: 0 };
    await sleep(60);
    assert.deepEqual(h.exits, []);
    // report 起因の処理が残る間も待つ
    h.running = { caps: 0, workers: 0, reports: 1 };
    await sleep(60);
    assert.deepEqual(h.exits, []);
    h.running = { caps: 0, workers: 0, reports: 0 };
    await sleep(80);
    assert.deepEqual(h.exits, ["update"]);
    assert.deepEqual(await readUpdateFile(dir), { state: "restart", to: "0.3.1", spec: "bantou@0.3.1" });
    assert.equal(c.hello().update?.state, "restarting");
    assert.equal(c.isUpdating(), true);
    c.close();
  });
});

test("request: extraBusy（受け付け済みで未登録の kick_cap）が 0 になるまで再起動しない", async () => {
  await withDir(async (dir) => {
    let busy = 1;
    const h = harness(dir, { extraBusy: () => busy });
    const c = createUpdateController(h.deps);
    const r = await c.request("0.3.1");
    assert.equal(r.state, "waiting");
    await sleep(60);
    assert.deepEqual(h.exits, []);
    busy = 0;
    await sleep(60);
    assert.deepEqual(h.exits, ["update"]);
    c.close();
  });
});

test("request: 最初から何も動いていなければ restarting を返し、すぐ終了を頼む", async () => {
  await withDir(async (dir) => {
    const h = harness(dir);
    const c = createUpdateController(h.deps);
    const r = await c.request("0.3.1");
    assert.equal(r.state, "restarting");
    assert.deepEqual(h.exits, ["update"]);
    assert.equal((await readUpdateFile(dir))?.state, "restart");
    c.close();
  });
});

test("request: 進行中に同じ版は冪等、別の版は update_conflict（retryable）", async () => {
  await withDir(async (dir) => {
    const h = harness(dir);
    h.running = { caps: 1, workers: 0, reports: 0 };
    const c = createUpdateController(h.deps);
    await c.request("0.3.1");
    const again = await c.request("0.3.1");
    assert.equal(again.state, "waiting");
    assert.equal(h.fetched.length, 1);
    await assert.rejects(
      c.request("0.3.2"),
      (e: unknown) => e instanceof UpdateError && e.code === "update_conflict" && e.retryable === true,
    );
    c.close();
  });
});

test("request: 取得に失敗したら update_failed、更新は始まらず lastFailure が hello に出る", async () => {
  await withDir(async (dir) => {
    const h = harness(dir, {
      fetch: async () => {
        throw new UpdateError("update_failed", "版 9.9.9 を取得できない", false);
      },
    });
    h.running = { caps: 1, workers: 0, reports: 0 };
    const c = createUpdateController(h.deps);
    await assert.rejects(c.request("9.9.9"), (e: unknown) => e instanceof UpdateError && e.code === "update_failed");
    assert.equal(c.isUpdating(), false);
    const hello = c.hello();
    assert.equal(hello.update, null);
    assert.equal(hello.last_update?.to, "9.9.9");
    assert.equal(hello.last_update?.ok, false);
    assert.match(hello.last_update?.error ?? "", /取得できない/);
    assert.deepEqual(h.exits, []);
    c.close();
  });
});

test("request: 取得中に別の版が来たら update_conflict、同じ版は同じ結果を待つ", async () => {
  await withDir(async (dir) => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const h = harness(dir, { fetch: async () => gate });
    h.running = { caps: 1, workers: 0, reports: 0 };
    const c = createUpdateController(h.deps);
    const first = c.request("0.3.1");
    await sleep(10);
    await assert.rejects(c.request("0.3.2"), (e: unknown) => e instanceof UpdateError && e.code === "update_conflict");
    const second = c.request("0.3.1");
    release();
    assert.equal((await first).state, "waiting");
    assert.equal((await second).state, "waiting");
    c.close();
  });
});

test("loadLastFailure: update.json の failed を hello の last_update に出す。restart は出さない", async () => {
  await withDir(async (dir) => {
    const c = createUpdateController(harness(dir).deps);
    await c.loadLastFailure();
    assert.equal(c.hello().last_update, null);
    await writeUpdateFile(dir, { state: "failed", to: "0.3.1", error: "起動できない", at: "2026-10-31T01:00:00.000Z" });
    await c.loadLastFailure();
    assert.deepEqual(c.hello().last_update, { to: "0.3.1", ok: false, error: "起動できない", at: "2026-10-31T01:00:00.000Z" });
    c.close();
  });
});

test("update.json を書けなければ更新を中止し、update_failed を返す", async () => {
  await withDir(async (dir) => {
    // workspace が通常ファイルだと update.json を書けない
    const bad = join(dir, "file");
    await writeFile(bad, "x");
    const h = harness(bad);
    const c = createUpdateController(h.deps);
    await assert.rejects(c.request("0.3.1"), (e: unknown) => e instanceof UpdateError && e.code === "update_failed");
    assert.equal(c.isUpdating(), false);
    assert.deepEqual(h.exits, []);
    c.close();
  });
});
