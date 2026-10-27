import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, DEFAULT_SESSION_COMMAND } from "../src/config.js";
import { prepareWorkspace } from "../src/workspace.js";

test("config 読込: workspace を取得し、欠落は拒否する", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bantou-server-test-"));
  try {
    const ok = join(dir, "config.json");
    await writeFile(ok, JSON.stringify({ workspace: "/x/ws" }));
    assert.deepEqual(await loadConfig(ok), {
      workspace: "/x/ws",
      broker: { port: 7901, bind: "0.0.0.0", discovery: "on", token: "" },
      session: { command: DEFAULT_SESSION_COMMAND },
    });

    const bad = join(dir, "bad.json");
    await writeFile(bad, "{}");
    await assert.rejects(loadConfig(bad), /workspace/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("workspace 作成: workspace と repos を作る", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bantou-server-test-"));
  try {
    const ws = join(dir, "ws");
    const repos = await prepareWorkspace(ws);
    assert.equal(repos, join(ws, "repos"));
    assert.ok((await stat(repos)).isDirectory());
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
