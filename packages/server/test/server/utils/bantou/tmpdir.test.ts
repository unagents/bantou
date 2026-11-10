import { test } from "node:test";
import assert from "node:assert/strict";
import { chmod, lstat, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentManager } from "../../../../server/utils/bantou/agents";
import { runBash } from "../../../../server/utils/bantou/bash";
import type { ClaudeRunOptions, ClaudeRunResult } from "../../../../server/utils/bantou/claude";
import { cleanWorkerDir } from "../../../../server/utils/bantou/cleanup";
import { DEFAULT_SESSION, type Config } from "../../../../server/utils/bantou/config";
import { ensureTmpDir } from "../../../../server/utils/bantou/paths";
import type { AgentRunner } from "../../../../server/utils/bantou/runner";

const ok: ClaudeRunResult = { ok: true, sessionId: "x", resultText: "r", durationMs: 1 };
const exists = (p: string): Promise<boolean> => lstat(p).then(() => true, () => false);

async function withFx(fn: (ws: string, calls: ClaudeRunOptions[], invoke: (kind: "cap" | "worker", id: string) => Promise<unknown>, config: Config) => Promise<void>): Promise<void> {
  const base = await mkdtemp(join(tmpdir(), "bantou-tmpdir-test-"));
  try {
    const ws = join(base, "ws");
    await mkdir(join(ws, "caps"), { recursive: true });
    await mkdir(join(ws, "workers"), { recursive: true });
    const config: Config = {
      workspace: ws,
      broker: { port: 0, bind: "127.0.0.1", discovery: "off", token: "" },
      mcp: { port: 0, bind: "127.0.0.1" },
      session: { ...structuredClone(DEFAULT_SESSION), maxRetries: 0 },
      update: { spec: "bantou@{version}" },
    };
    const calls: ClaudeRunOptions[] = [];
    const runner: AgentRunner = { run: async (o) => (calls.push(o), ok) };
    const m = createAgentManager({ config, runner, log: () => {} });
    await fn(ws, calls, (kind, id) => m.invoke(kind, id, { prompt: "p" }), config);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}

test("TMPDIR: cap / worker の起動 env に自分の path の tmp/ が入り、dir が mode 700 で作られる", async () => {
  await withFx(async (ws, calls, invoke) => {
    await invoke("cap", "c1");
    await invoke("worker", "w1");
    assert.equal(calls[0]!.env?.TMPDIR, join(ws, "caps", "c1", "tmp"));
    assert.equal(calls[1]!.env?.TMPDIR, join(ws, "workers", "w1", "tmp"));
    for (const d of [join(ws, "caps", "c1", "tmp"), join(ws, "workers", "w1", "tmp")]) {
      const st = await lstat(d);
      assert.ok(st.isDirectory());
      assert.equal(st.mode & 0o777, 0o700);
    }
  });
});

test("TMPDIR: resume でも毎回作る（消えていたら作り直し、緩い mode は 700 に戻し、厳しい mode は保つ）", async () => {
  await withFx(async (ws, calls, invoke) => {
    await invoke("worker", "w1");
    const tmp = join(ws, "workers", "w1", "tmp");
    await chmod(tmp, 0o750);
    await invoke("worker", "w1");
    assert.equal(calls[1]!.mode, "resume");
    assert.equal((await lstat(tmp)).mode & 0o777, 0o700); // 緩い mode は 700 に戻す
    await chmod(tmp, 0o500);
    await invoke("worker", "w1");
    assert.equal((await lstat(tmp)).mode & 0o777, 0o500); // 700 以下の厳しい mode は触らない
    await chmod(tmp, 0o700);
    await rm(tmp, { recursive: true });
    await invoke("worker", "w1");
    assert.equal(calls[2]!.mode, "resume");
    assert.equal((await lstat(tmp)).mode & 0o777, 0o700);
  });
});

test("TMPDIR: session.env で TMPDIR を指定されても自分の path の tmp/ のまま", async () => {
  await withFx(async (ws, calls, invoke, config) => {
    config.session.env = { TMPDIR: "/tmp" };
    await invoke("worker", "w1");
    assert.equal(calls[0]!.env?.TMPDIR, join(ws, "workers", "w1", "tmp"));
  });
});

test("TMPDIR: tmp が symlink / file なら消して dir を作り直す（外を指さない）", async () => {
  const base = await mkdtemp(join(tmpdir(), "bantou-tmpdir-test-"));
  try {
    const out = join(base, "out");
    await mkdir(out);
    const dir = join(base, "d");
    await mkdir(dir);
    await symlink(out, join(dir, "tmp"));
    assert.equal(await ensureTmpDir(dir), join(dir, "tmp"));
    const st = await lstat(join(dir, "tmp"));
    assert.ok(st.isDirectory() && !st.isSymbolicLink());
    assert.ok(await exists(out));
    await rm(join(dir, "tmp"), { recursive: true });
    await writeFile(join(dir, "tmp"), "x");
    await ensureTmpDir(dir);
    assert.ok((await lstat(join(dir, "tmp"))).isDirectory());
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("TMPDIR: worker の掃除で tmp/ も消え、logs/ と state.json は残る", async () => {
  await withFx(async (ws, _calls, invoke) => {
    await invoke("worker", "w1");
    const dir = join(ws, "workers", "w1");
    await writeFile(join(dir, "tmp", "t.txt"), "x");
    await cleanWorkerDir(dir);
    assert.ok(!(await exists(join(dir, "tmp"))));
    assert.ok(await exists(join(dir, "state.json")));
    assert.ok(await exists(join(dir, "logs")));
  });
});

test("TMPDIR: bash の rm で tmp/ 配下を消せる（tmp 自体は recursive 無しだと拒否、recursive で許可）", async () => {
  await withFx(async (ws, _calls, invoke) => {
    await invoke("worker", "w1");
    const w1 = { kind: "worker", capId: "c1", workerId: "w1" } as const;
    const tmp = join(ws, "workers", "w1", "tmp");
    await mkdir(join(tmp, "sub"), { recursive: true });
    await writeFile(join(tmp, "sub", "a.txt"), "x");
    await writeFile(join(tmp, "b.txt"), "x");
    const r1 = await runBash(ws, w1, { action: "rm", paths: ["tmp/b.txt", "tmp/sub", "tmp"] });
    assert.deepEqual(r1.removed, ["tmp/b.txt"]);
    assert.equal(r1.skipped.length, 2);
    assert.match(r1.skipped[0]!.reason, /recursive: true/);
    const r2 = await runBash(ws, w1, { action: "rm", paths: ["tmp/sub", "tmp"], recursive: true });
    assert.deepEqual(r2.removed, ["tmp/sub", "tmp"]);
    assert.ok(!(await exists(tmp)));
  });
});
