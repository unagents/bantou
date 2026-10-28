import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readState, writeState, type AgentStateFile } from "../../../../server/utils/bantou/state";

async function withDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "bantou-state-test-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("state: ファイル無しは既定値", async () => {
  await withDir(async (dir) => {
    assert.deepEqual(await readState(join(dir, "none")), {
      session_id: null,
      state: "idle",
      last_started_at: null,
      last_finished_at: null,
      retries: 0,
    });
  });
});

test("state: 書いて読むと同じ。dir が無くても作り、tmp は残らない", async () => {
  await withDir(async (dir) => {
    const target = join(dir, "caps", "c1");
    const s: AgentStateFile = {
      session_id: "abc",
      state: "failed",
      last_started_at: "2026-01-01T00:00:00.000Z",
      last_finished_at: "2026-01-01T00:01:00.000Z",
      last_error: "boom",
      retries: 2,
    };
    await writeState(target, s);
    assert.deepEqual(await readState(target), s);
    assert.deepEqual(await readdir(target), ["state.json"]);
  });
});

test("state: 書き込み失敗時は tmp を残さず投げる", async () => {
  await withDir(async (dir) => {
    // state.json の位置がディレクトリだと rename が失敗する
    await mkdir(join(dir, "state.json"));
    const s: AgentStateFile = { session_id: null, state: "idle", last_started_at: null, last_finished_at: null, retries: 0 };
    await assert.rejects(writeState(dir, s));
    assert.deepEqual(await readdir(dir), ["state.json"]);
  });
});

test("state: 壊れた JSON は path 付きで投げる", async () => {
  await withDir(async (dir) => {
    await writeFile(join(dir, "state.json"), "{not json");
    await assert.rejects(readState(dir), (e: Error) => e.message.includes(join(dir, "state.json")));
  });
});

test("state: 形が不正（state 値）は投げる", async () => {
  await withDir(async (dir) => {
    await writeFile(
      join(dir, "state.json"),
      JSON.stringify({ session_id: null, state: "weird", last_started_at: null, last_finished_at: null, retries: 0 }),
    );
    await assert.rejects(readState(dir), /state の形が不正/);
  });
});
