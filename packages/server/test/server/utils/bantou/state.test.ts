import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findWorkerBySession, readState, writeState, type WorkerState } from "../../../../server/utils/bantou/state";

const sample = (id: string, session: string): WorkerState => ({
  worker_id: id,
  session_id: session,
  parent_id: "cap-1",
  ws: "ws://127.0.0.1:1/x",
  model: "sonnet",
  last_started_at: "2026-11-23T00:00:00.000Z",
  last_finished_at: null,
});

test("state: 無ければ undefined、書いて読める", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bantou-state-test-"));
  try {
    assert.equal(await readState(dir), undefined);
    await writeState(dir, sample("w-1", "s-1"));
    assert.deepEqual(await readState(dir), sample("w-1", "s-1"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("state: state.json は 0600（ws の token・schema の認証の値が生で入る）。毎回の書き直しでも保つ", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bantou-state-test-"));
  try {
    const schema = { type: "http" as const, url: "http://c:1/mcp/schemas", headers: { Authorization: "Bearer x" } };
    await writeState(dir, { ...sample("w-1", "s-1"), schema });
    assert.equal((await stat(join(dir, "state.json"))).mode & 0o777, 0o600);
    await writeState(dir, { ...sample("w-1", "s-2"), schema });
    assert.equal((await stat(join(dir, "state.json"))).mode & 0o777, 0o600);
    assert.deepEqual((await readState(dir))?.schema, schema);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("state: JSON 不正・形の不正は path 付きで投げる", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bantou-state-test-"));
  try {
    await writeFile(join(dir, "state.json"), "{not json");
    await assert.rejects(readState(dir), /JSON として不正/);
    await writeFile(join(dir, "state.json"), JSON.stringify({ worker_id: "w-1" }));
    await assert.rejects(readState(dir), /形が不正/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("findWorkerBySession: session-id の worker を workers/ から引く（壊れた state・不正な名前は読み飛ばす）", async () => {
  const ws = await mkdtemp(join(tmpdir(), "bantou-state-test-"));
  try {
    assert.equal(await findWorkerBySession(ws, "s-2"), undefined);
    await writeState(join(ws, "workers", "w-1"), sample("w-1", "s-1"));
    await writeState(join(ws, "workers", "w-2"), sample("w-2", "s-2"));
    await mkdir(join(ws, "workers", "w-3"), { recursive: true });
    await writeFile(join(ws, "workers", "w-3", "state.json"), "{bad");
    await mkdir(join(ws, "workers", "bad name"), { recursive: true });
    const hit = await findWorkerBySession(ws, "s-2");
    assert.equal(hit?.dir, join(ws, "workers", "w-2"));
    assert.equal(hit?.state.worker_id, "w-2");
    assert.equal(await findWorkerBySession(ws, "s-9"), undefined);
  } finally {
    await rm(ws, { recursive: true, force: true });
  }
});
