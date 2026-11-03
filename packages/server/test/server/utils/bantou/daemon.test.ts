import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareWorkspace } from "../../../../server/utils/bantou/workspace";
import { REPLY_META, classifyMeta, describeCommand, execute, executeUpdate, maskUserinfo, updatingError } from "../../../../server/utils/bantou/daemon";
import { UpdateError, createUpdateController } from "../../../../server/utils/bantou/update";
import type { AgentManager } from "../../../../server/utils/bantou/agents";

test("workspace 作成: caps と workers を作る", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bantou-server-test-"));
  try {
    const ws = join(dir, "ws");
    const r = await prepareWorkspace(ws);
    assert.deepEqual(r, { caps: join(ws, "caps"), workers: join(ws, "workers") });
    assert.ok((await stat(r.caps)).isDirectory());
    assert.ok((await stat(r.workers)).isDirectory());
    await assert.rejects(stat(join(ws, "repos")));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("指示ログ: prompt は先頭 80 文字、repo の userinfo は伏せる", () => {
  const long = "x".repeat(200);
  const line = describeCommand({
    bantou: 1,
    type: "kick_cap",
    cap_id: "c1",
    repo: "https://user:pw@example.com/o/r.git",
    prompt: long,
  });
  assert.ok(line.includes("cap_id=c1"));
  assert.ok(line.includes("repo=https://***@example.com/o/r.git"));
  assert.ok(!line.includes("pw"));
  assert.ok(line.includes(`prompt=${"x".repeat(80)}`));
  assert.ok(!line.includes("x".repeat(81)));
  assert.equal(describeCommand({ bantou: 1, type: "status" }), "");
  assert.equal(maskUserinfo("git@h"), "git@h");
});

test("error 返信: 失敗した指示の cap_id を含める。resume_worker は未対応", async () => {
  const manager = {
    invoke: async () => {
      throw new Error("boom");
    },
    status: async () => {
      throw new Error("boom");
    },
  } as unknown as AgentManager;
  const cap = await execute({ bantou: 1, type: "kick_cap", cap_id: "c1", prompt: "p" }, manager);
  assert.deepEqual(cap, { bantou: 1, type: "error", ok: false, message: "boom", command: "kick_cap", cap_id: "c1" });
  const w = await execute({ bantou: 1, type: "resume_worker", worker_id: "w1", prompt: "p" }, manager);
  assert.deepEqual(w, { bantou: 1, type: "error", ok: false, message: "resume_worker は未対応", command: "resume_worker" });
  const st = await execute({ bantou: 1, type: "status" }, manager);
  assert.deepEqual(st, { bantou: 1, type: "error", ok: false, message: "boom", command: "status" });
  const stop = await execute({ bantou: 1, type: "stop_cap", cap_id: "c1" }, { stop: async () => { throw new Error("boom"); } } as unknown as AgentManager);
  assert.deepEqual(stop, { bantou: 1, type: "error", ok: false, message: "boom", command: "stop_cap", cap_id: "c1" });
});

test("meta の分類: 無し=旧形式、bantou=処理、他 protocol=無視", () => {
  assert.equal(classifyMeta(undefined), "legacy");
  assert.equal(classifyMeta(null), "legacy");
  assert.equal(classifyMeta({ protocol: "bantou", version: "1.0.0" }), "bantou");
  assert.equal(classifyMeta({ protocol: "bantou", version: "9.9.9" }), "bantou");
  assert.equal(classifyMeta({ protocol: "other", version: "1.0.0" }), "other");
});

test("返信 meta は protocol.json の name / version と一致する", async () => {
  const dir = new URL("../../../../../packages/protocol/messenger/", import.meta.url);
  const m = JSON.parse(await readFile(new URL("protocol.json", dir), "utf8")) as { name: string; version: string };
  assert.deepEqual(REPLY_META, { protocol: m.name, version: m.version });
});

test("stop_cap: manager.stop の結果を stop_result で返し、ログ概要は cap_id", async () => {
  const calls: unknown[] = [];
  const manager = { stop: async (k: string, id: string) => (calls.push([k, id]), { stopped: true }) } as unknown as AgentManager;
  const r = await execute({ bantou: 1, type: "stop_cap", cap_id: "c9" }, manager);
  assert.deepEqual(r, { bantou: 1, type: "stop_result", ok: true, cap_id: "c9", stopped: true });
  assert.deepEqual(calls, [["cap", "c9"]]);
  assert.equal(describeCommand({ bantou: 1, type: "stop_cap", cap_id: "c9" }), "cap_id=c9");
});

test("update_server: ログ概要は version。execute では処理しない（daemon が UpdateController で処理する）", async () => {
  assert.equal(describeCommand({ bantou: 1, type: "update_server", version: "0.3.1" }), "version=0.3.1");
  assert.equal(describeCommand({ bantou: 1, type: "hello" }), "");
  const manager = {} as unknown as AgentManager;
  const r = await execute({ bantou: 1, type: "hello" }, manager);
  assert.equal(r.type, "error");
});

test("updatingError: 理由付き・retryable・cap_id 付きの kick_cap 向け error", () => {
  const r = updatingError({ cap_id: "c1" }, { from: "0.3.0", to: "0.3.1" });
  assert.equal(r.type, "error");
  if (r.type !== "error") return;
  assert.equal(r.ok, false);
  assert.equal(r.code, "updating");
  assert.equal(r.retryable, true);
  assert.equal(r.command, "kick_cap");
  assert.equal(r.cap_id, "c1");
  assert.match(r.message, /0\.3\.0→0\.3\.1/);
  assert.match(r.message, /再送/);
});

test("executeUpdate: hello は hello_result、update_server の失敗は code 付き error", async () => {
  const controller = createUpdateController({
    workspace: "/nonexistent-ws",
    serverVersion: "0.3.0",
    specTemplate: "bantou@{version}",
    running: () => ({ caps: 0, workers: 0, reports: 0 }),
    fetch: async () => {
      throw new UpdateError("update_failed", "取得できない", false);
    },
    requestExit: () => {},
    log: () => {},
  });
  const h = await executeUpdate({ bantou: 1, type: "hello" }, controller);
  assert.equal(h.type, "hello_result");
  const e = await executeUpdate({ bantou: 1, type: "update_server", version: "0.3.1" }, controller);
  assert.deepEqual(e, {
    bantou: 1, type: "error", ok: false, message: "取得できない", command: "update_server", code: "update_failed", retryable: false,
  });
  controller.close();
});
