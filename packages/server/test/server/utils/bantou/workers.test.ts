import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentActivity } from "@agent-hand/bantou-protocol";
import type { InvokeInput } from "../../../../server/utils/bantou/agents";
import {
  createWorkerHub,
  getWorkerHandler,
  readOwner,
  setWorkerHandler,
  writeOwner,
} from "../../../../server/utils/bantou/workers";
import { writeState } from "../../../../server/utils/bantou/state";

interface Fx {
  ws: string;
  invoked: Array<[string, string, InvokeInput]>;
  stopped: string[];
  hub: ReturnType<typeof createWorkerHub>;
  tracked: AgentActivity[];
  logs: string[];
}

async function withHub(fn: (f: Fx) => Promise<void>, invoke?: () => Promise<{ session_id: string; ok: boolean; result_text: string }>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "bantou-workers-test-"));
  try {
    const ws = join(dir, "ws");
    await mkdir(join(ws, "caps", "c1"), { recursive: true });
    await mkdir(join(ws, "caps", "c2"), { recursive: true });
    const invoked: Fx["invoked"] = [];
    const stopped: string[] = [];
    const tracked: AgentActivity[] = [];
    const logs: string[] = [];
    let n = 0;
    const hub = createWorkerHub({
      workspace: ws,
      manager: {
        invoke: async (kind, id, input) => {
          invoked.push([kind, id, input]);
          return invoke ? invoke() : { session_id: "s", ok: true, result_text: "" };
        },
        stop: async (_k, id) => (stopped.push(id), { stopped: true }),
      },
      activity: { snapshot: (capId) => tracked.filter((a) => capId === undefined || a.cap_id === capId) },
      log: (m) => logs.push(m),
      newId: () => `w-gen${++n}`,
    });
    await fn({ ws, invoked, stopped, hub, tracked, logs });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const act = (id: string, capId: string, state: AgentActivity["state"] = "running"): AgentActivity => ({
  kind: "worker", id, cap_id: capId, state, task: "t", last_activity: null, last_output_at: null, silent_ms: 0, started_at: null, finished_at: null,
});

test("worker_start: 採番し、持ち主を logs/owner.json に書き、完了を待たずに accepted を返す", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  await withHub(
    async ({ ws, hub, invoked }) => {
      const r = await hub.start("c1", { prompt: "作業", branch: "dev" });
      assert.deepEqual(r, { worker_id: "w-gen1", accepted: true });
      assert.equal(invoked.length, 1);
      assert.equal(invoked[0]![0], "worker");
      assert.equal(invoked[0]![1], "w-gen1");
      assert.equal(invoked[0]![2].prompt, "作業");
      assert.equal(invoked[0]![2].capId, "c1");
      assert.equal(invoked[0]![2].branch, "dev");
      assert.deepEqual(JSON.parse(await readFile(join(ws, "workers", "w-gen1", "logs", "owner.json"), "utf8")), { cap_id: "c1" });
      assert.equal(await readOwner(ws, "w-gen1"), "c1");
      release();
    },
    () => gate.then(() => ({ session_id: "s", ok: true, result_text: "" })),
  );
});

test("worker_start: 既存の worker_id は続きの指示（同じ持ち主なら通る）。別の cap のものは拒否", async () => {
  await withHub(async ({ hub, invoked }) => {
    await hub.start("c1", { worker_id: "w1", prompt: "a" });
    const r = await hub.start("c1", { worker_id: "w1", prompt: "b" });
    assert.deepEqual(r, { worker_id: "w1", accepted: true });
    assert.equal(invoked.length, 2);
    await assert.rejects(hub.start("c2", { worker_id: "w1", prompt: "c" }), /別の cap の worker: w1/);
    assert.equal(invoked.length, 2);
  });
});

test("worker_start: 不正な入力・存在しない cap は投げて invoke しない", async () => {
  await withHub(async ({ hub, invoked }) => {
    await assert.rejects(hub.start("nocap", { prompt: "p" }), /cap が存在しない: nocap/);
    await assert.rejects(hub.start("../x", { prompt: "p" }), /cap_id が不正/);
    await assert.rejects(hub.start("c1", { worker_id: "a b", prompt: "p" }), /worker_id が不正/);
    await assert.rejects(hub.start("c1", { prompt: "" }), /prompt は/);
    await assert.rejects(hub.start("c1", { prompt: "a\0b" }), /prompt は/);
    assert.equal(invoked.length, 0);
  });
});

test("worker_start: invoke の失敗は握ってログに出す（accepted は返っている）", async () => {
  await withHub(
    async ({ hub, logs }) => {
      const r = await hub.start("c1", { prompt: "p" });
      assert.equal(r.accepted, true);
      await new Promise((res) => setTimeout(res, 20));
      assert.ok(logs.some((l) => l.includes("エラー: worker 起動") && l.includes("boom")));
    },
    async () => {
      throw new Error("boom");
    },
  );
});

test("worker_status: 呼んだ cap の worker だけ。tracker に無い worker は state.json から補う", async () => {
  await withHub(async ({ ws, hub, tracked }) => {
    tracked.push(act("w1", "c1"), act("w9", "c2"));
    await writeOwner(ws, "w1", "c1");
    await writeOwner(ws, "w9", "c2");
    // server 再起動前の worker（tracker に無い）
    await writeOwner(ws, "w2", "c1");
    await writeState(join(ws, "workers", "w2"), { session_id: "s", state: "idle", last_started_at: "2026-10-29T00:00:00.000Z", last_finished_at: "2026-10-29T00:01:00.000Z", retries: 0 });
    await writeOwner(ws, "w3", "c1");
    await writeState(join(ws, "workers", "w3"), { session_id: "s", state: "failed", last_started_at: "2026-10-29T00:00:00.000Z", last_finished_at: "2026-10-29T00:01:00.000Z", last_error: "e", retries: 0 });
    await writeOwner(ws, "w4", "c1");
    await writeState(join(ws, "workers", "w4"), { session_id: "s", state: "running", last_started_at: "2026-10-29T00:00:00.000Z", last_finished_at: null, retries: 0 });
    // 起動直後（state.json 無し）は running / starting
    await writeOwner(ws, "w5", "c1");

    const { workers } = await hub.status("c1");
    assert.deepEqual(workers.map((w) => [w.id, w.state]), [["w1", "running"], ["w2", "idle"], ["w3", "failed"], ["w4", "running"], ["w5", "running"]]);
    assert.equal(workers.find((w) => w.id === "w3")!.error, "e");
    assert.equal(workers.find((w) => w.id === "w5")!.last_activity, "starting");
    assert.ok(workers.every((w) => w.cap_id === "c1"));

    const one = await hub.status("c1", "w2");
    assert.deepEqual(one.workers.map((w) => w.id), ["w2"]);
    await assert.rejects(hub.status("c1", "w9"), /別の cap の worker: w9/);
    await assert.rejects(hub.status("c1", "nope"), /worker が存在しない: nope/);
    await assert.rejects(hub.status("nocap"), /cap が存在しない/);
  });
});

test("worker_stop: 持ち主の cap だけが止められる", async () => {
  await withHub(async ({ ws, hub, stopped }) => {
    await writeOwner(ws, "w1", "c1");
    assert.deepEqual(await hub.stop("c1", "w1"), { worker_id: "w1", stopped: true });
    assert.deepEqual(stopped, ["w1"]);
    await assert.rejects(hub.stop("c2", "w1"), /別の cap の worker: w1/);
    await assert.rejects(hub.stop("c1", "nope"), /worker が存在しない/);
    await assert.rejects(hub.stop("c1", "a b"), /worker_id が不正/);
    assert.deepEqual(stopped, ["w1"]);
  });
});

test("worker handler: set / get / 解除", () => {
  assert.equal(getWorkerHandler(), undefined);
  const h = { start: async () => ({ worker_id: "x", accepted: true as const }), status: async () => ({ workers: [] }), stop: async () => ({ worker_id: "x", stopped: false }) };
  setWorkerHandler(h);
  assert.equal(getWorkerHandler(), h);
  setWorkerHandler(undefined);
  assert.equal(getWorkerHandler(), undefined);
});
