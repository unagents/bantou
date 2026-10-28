import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareWorkspace } from "../../../../server/utils/bantou/workspace";
import { brokerHost, describeCommand, execute, maskUserinfo } from "../../../../server/utils/bantou/daemon";
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

test("error 返信: 失敗した指示の cap_id / worker_id を含める", async () => {
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
  assert.deepEqual(w, { bantou: 1, type: "error", ok: false, message: "boom", command: "resume_worker", worker_id: "w1" });
  const st = await execute({ bantou: 1, type: "status" }, manager);
  assert.deepEqual(st, { bantou: 1, type: "error", ok: false, message: "boom", command: "status" });
});

test("指示ログ: spawn_worker / worker_report", () => {
  const sw = describeCommand({ bantou: 1, type: "spawn_worker", worker_id: "w1", cap_id: "c1", prompt: "p" });
  assert.ok(sw.includes("worker_id=w1") && sw.includes("cap_id=c1") && sw.includes("prompt=p"));
  const wr = describeCommand({ bantou: 1, type: "worker_report", worker_id: "w1", kind: "done", text: "a\nb" });
  assert.equal(wr, "worker_id=w1 kind=done text=a b");
});

test("brokerHost: 全 IF bind は loopback", () => {
  assert.equal(brokerHost("0.0.0.0"), "127.0.0.1");
  assert.equal(brokerHost(""), "127.0.0.1");
  assert.equal(brokerHost("::"), "::1");
  assert.equal(brokerHost("10.0.0.5"), "10.0.0.5");
});

test("execute: kick_cap の送り主を reply_to.json の sidecar として渡す。spawn_worker / worker_report は扱わない", async () => {
  let seen: unknown;
  const manager = {
    invoke: async (_k: string, _i: string, input: unknown) => {
      seen = input;
      return { session_id: "s", ok: true, result_text: "r" };
    },
  } as unknown as AgentManager;
  await execute({ bantou: 1, type: "kick_cap", cap_id: "c1", prompt: "p" }, manager, { id: "p1", name: "ext" });
  assert.deepEqual((seen as { sidecar: unknown }).sidecar, { name: "reply_to.json", data: { id: "p1", name: "ext" } });
  const r = await execute({ bantou: 1, type: "worker_report", worker_id: "w1", kind: "done", text: "t" }, manager);
  assert.equal(r.type, "error");
});
