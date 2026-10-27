import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareWorkspace } from "../src/workspace.js";
import { describeCommand, maskUserinfo } from "../src/daemon.js";

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
