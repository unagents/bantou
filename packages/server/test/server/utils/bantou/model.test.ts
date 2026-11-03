import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { toNodeListener, createApp, defineEventHandler, toWebRequest } from "h3";
import { createAgentManager, type InvokeInput } from "../../../../server/utils/bantou/agents";
import { createActivityTracker } from "../../../../server/utils/bantou/activity";
import { buildClaudeArgs, type ClaudeRunOptions, type ClaudeRunResult } from "../../../../server/utils/bantou/claude";
import { DEFAULT_SESSION, type Config } from "../../../../server/utils/bantou/config";
import { describeCommand } from "../../../../server/utils/bantou/daemon";
import { handleMcpRequest, startMcpListener } from "../../../../server/utils/bantou/mcp";
import { assertModel, readModelRecord, writeModelRecord } from "../../../../server/utils/bantou/model";
import type { AgentRunner } from "../../../../server/utils/bantou/runner";
import { createWorkerHub, setWorkerHandler, writeOwner } from "../../../../server/utils/bantou/workers";
import { writeState } from "../../../../server/utils/bantou/state";

const base: ClaudeRunOptions = {
  claude: "claude", sessionId: "sid", mode: "new", prompt: "p", cwd: ".", permissionMode: "auto",
  allowedTools: [], disallowedTools: [], extraArgs: [], timeoutMs: 5000,
};
const okRun = (): ClaudeRunResult => ({ ok: true, sessionId: "x", resultText: "r", durationMs: 1 });

async function withWs(fn: (ws: string, config: Config) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "bantou-model-test-"));
  try {
    const ws = join(dir, "ws");
    await mkdir(join(ws, "caps", "c1"), { recursive: true });
    await mkdir(join(ws, "workers"), { recursive: true });
    const config: Config = {
      workspace: ws,
      broker: { port: 0, bind: "127.0.0.1", discovery: "off", token: "" },
      mcp: { port: 0, bind: "127.0.0.1" },
      session: { ...structuredClone(DEFAULT_SESSION), maxRetries: 0 },
      update: { spec: "bantou@{version}" },
    };
    await fn(ws, config);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("model: 形式検証（sonnet / フル ID / [1m] は可、空白・; ・先頭 - 以外の記号は不可）", () => {
  for (const ok of ["sonnet", "opus", "claude-sonnet-5-5", "claude-opus-5-5[1m]", "a.b_c-1"]) assert.equal(assertModel(ok), ok);
  for (const ng of ["", "-x", "--model", "a b", "a;b", "a\nb", "a/b", 5, null]) assert.throws(() => assertModel(ng), /model が不正/);
});

test("claude: model 指定は extraArgs の後ろに --model を付ける。省略なら付けない（resume も同じ）", () => {
  assert.equal(buildClaudeArgs(base).includes("--model"), false);
  for (const mode of ["new", "resume"] as const) {
    const a = buildClaudeArgs({ ...base, mode, model: "opus", extraArgs: ["--model", "sonnet"] });
    assert.equal(a[a.lastIndexOf("--model") + 1], "opus");
    assert.ok(a.lastIndexOf("--model") > a.indexOf("sonnet"));
    assert.ok(a.lastIndexOf("--model") < a.indexOf(mode === "new" ? "--session-id" : "--resume"));
  }
});

test("model 記録: 指定項目だけ上書き、壊れた・不正な値は無視", async () => {
  await withWs(async (ws) => {
    const dir = join(ws, "caps", "c1");
    assert.deepEqual(await readModelRecord(dir), {});
    await writeModelRecord(dir, { model: "opus" });
    await writeModelRecord(dir, { worker_model: "haiku" });
    assert.deepEqual(await readModelRecord(dir), { model: "opus", worker_model: "haiku" });
    await writeModelRecord(dir, { model: "sonnet" });
    assert.deepEqual(await readModelRecord(dir), { model: "sonnet", worker_model: "haiku" });
    await writeFileRaw(join(dir, "logs", "model.json"), '{"model":"a b","worker_model":3}');
    assert.deepEqual(await readModelRecord(dir), {});
  });
});

async function writeFileRaw(p: string, s: string): Promise<void> {
  const { writeFile } = await import("node:fs/promises");
  await writeFile(p, s);
}

function mgr(config: Config, calls: ClaudeRunOptions[], extra = {}) {
  const runner: AgentRunner = { run: async (o) => (calls.push(o), okRun()) };
  return createAgentManager({ config, runner, log: () => {}, ...extra });
}

test("agents: model は claude に渡り、指定が無い再開（report 起因など）でも同じモデルを使い続ける", async () => {
  await withWs(async (_ws, config) => {
    const calls: ClaudeRunOptions[] = [];
    const m = mgr(config, calls);
    await m.invoke("cap", "c1", { prompt: "a", model: "opus", worker_model: "haiku" } as InvokeInput);
    await m.invoke("cap", "c1", { prompt: "b", keepTask: true });
    assert.deepEqual(calls.map((c) => [c.mode, c.model]), [["new", "opus"], ["resume", "opus"]]);
    // 別のモデルを指定すれば切り替わり、以後それを使う
    await m.invoke("cap", "c1", { prompt: "c", model: "sonnet" });
    await m.invoke("cap", "c1", { prompt: "d" });
    assert.deepEqual(calls.slice(2).map((c) => c.model), ["sonnet", "sonnet"]);
  });
});

test("agents: resume の kick_cap で worker_model を渡すと cap の既定が更新される（渡さなければそのまま）", async () => {
  await withWs(async (ws, config) => {
    const calls: ClaudeRunOptions[] = [];
    const m = mgr(config, calls);
    const dir = join(ws, "caps", "c1");
    await m.invoke("cap", "c1", { prompt: "a", model: "opus", worker_model: "haiku" } as InvokeInput);
    await m.invoke("cap", "c1", { prompt: "b", worker_model: "sonnet" } as InvokeInput);
    assert.deepEqual(calls.map((c) => c.mode), ["new", "resume"]);
    assert.deepEqual(await readModelRecord(dir), { model: "opus", worker_model: "sonnet" });
    await m.invoke("cap", "c1", { prompt: "c" });
    assert.deepEqual(await readModelRecord(dir), { model: "opus", worker_model: "sonnet" });
  });
});

test("agents: model 指定が一度も無ければ --model 用の値は渡さず、記録ファイルも作らない", async () => {
  await withWs(async (ws, config) => {
    const calls: ClaudeRunOptions[] = [];
    await mgr(config, calls).invoke("cap", "c1", { prompt: "a" });
    assert.equal("model" in calls[0]!, false);
    await assert.rejects(readFile(join(ws, "caps", "c1", "logs", "model.json"), "utf8"));
  });
});

test("agents: defaultModel は記録が無い時だけ使う。不正な model は invoke が拒否して claude を起動しない", async () => {
  await withWs(async (ws, config) => {
    const calls: ClaudeRunOptions[] = [];
    const runExtras = async () => ({});
    const m = mgr(config, calls, { runExtras });
    await m.invoke("worker", "w1", { prompt: "a", defaultModel: "haiku" });
    await m.invoke("worker", "w1", { prompt: "b", defaultModel: "sonnet" });
    assert.deepEqual(calls.map((c) => c.model), ["haiku", "haiku"]);
    await assert.rejects(m.invoke("cap", "c1", { prompt: "x", model: "a b" }), /model が不正/);
    await assert.rejects(m.invoke("cap", "c1", { prompt: "x", worker_model: "a;b" }), /worker_model が不正/);
    assert.equal(calls.length, 2);
    assert.deepEqual(await readModelRecord(join(ws, "workers", "w1")), { model: "haiku" });
  });
});

test("worker_start: model 優先順位 = 指定 > worker の前回記録 > cap の worker_model > 付けない", async () => {
  await withWs(async (ws, config) => {
    const calls: ClaudeRunOptions[] = [];
    const m = mgr(config, calls, { runExtras: async () => ({}) });
    const hub = createWorkerHub({
      workspace: ws, manager: m, activity: { snapshot: () => [] }, log: () => {},
      newId: (() => { let n = 0; return () => `w-g${++n}`; })(),
    });
    const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 50));
    // cap に worker_model が無い: 付けない
    await hub.start("c1", { prompt: "a" });
    await settle();
    assert.equal("model" in calls[0]!, false);
    await writeModelRecord(join(ws, "caps", "c1"), { worker_model: "haiku" });
    await hub.start("c1", { prompt: "b" });
    await hub.start("c1", { prompt: "c", model: "opus" });
    await settle();
    assert.deepEqual(calls.slice(1).map((c) => c.model).sort(), ["haiku", "opus"]);
    // 同じ worker_id への続き: 前回の記録（opus）が cap の既定（haiku）より優先
    await hub.start("c1", { prompt: "d", worker_id: "w-g3" });
    await settle();
    assert.equal(calls[3]!.model, "opus");
    await assert.rejects(hub.start("c1", { prompt: "e", model: "x y" }), /model が不正/);
  });
});

test("worker_status: model は記録した値、無ければ null（tracker に無い worker）", async () => {
  await withWs(async (ws, config) => {
    const hub = createWorkerHub({
      workspace: ws, manager: mgr(config, []), activity: { snapshot: () => [] }, log: () => {},
    });
    for (const id of ["w1", "w2"]) {
      await writeOwner(ws, id, "c1");
      await mkdir(join(ws, "workers", id), { recursive: true });
      await writeState(join(ws, "workers", id), { session_id: "s", state: "idle", last_started_at: null, last_finished_at: null, retries: 0 });
    }
    await writeModelRecord(join(ws, "workers", "w1"), { model: "opus" });
    const { workers } = await hub.status("c1");
    assert.deepEqual(workers.map((w) => [w.id, w.model]), [["w1", "opus"], ["w2", null]]);
  });
});

test("activity: agents[] の model は指定されたもの、無ければ null", () => {
  const tr = createActivityTracker({ notify: async () => {}, log: () => {}, intervalMs: 3_600_000 });
  try {
    tr.started("cap", "c1", { prompt: "p", resolvedModel: "opus" }, 1);
    tr.started("worker", "w1", { prompt: "p", capId: "c1" }, 2);
    assert.deepEqual(tr.snapshot("c1").map((a) => [a.id, a.model]), [["c1", "opus"], ["w1", null]]);
  } finally {
    tr.close();
  }
});

test("daemon: describeCommand に model / worker_model を出す（無ければ出さない）", () => {
  const cmd = { bantou: 1, type: "kick_cap", cap_id: "c1", prompt: "p", model: "opus", worker_model: "haiku" } as never;
  assert.match(describeCommand(cmd), /model=opus worker_model=haiku/);
  assert.doesNotMatch(describeCommand({ bantou: 1, type: "kick_cap", cap_id: "c1", prompt: "p" } as never), /model/);
});

test("mcp: worker_start の model は hub に渡り、不正な形式は hub に届かない", async () => {
  const got: unknown[] = [];
  setWorkerHandler({
    start: async (c, i) => (got.push([c, i]), { worker_id: "w", accepted: true }),
    status: async () => ({ workers: [] }),
    stop: async (_c, w) => ({ worker_id: w, stopped: true }),
  });
  const app = createApp().use("/mcp", defineEventHandler((e) => handleMcpRequest(toWebRequest(e))));
  const l = await startMcpListener(toNodeListener(app), { port: 0, bind: "127.0.0.1" });
  try {
    const url = `http://127.0.0.1:${l.port}/mcp`;
    const headers = { "content-type": "application/json", accept: "application/json, text/event-stream", "x-bantou-cap-id": "c1" };
    const call = async (args: object) =>
      (await (await fetch(url, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "worker_start", arguments: args } }) })).json()) as { error?: unknown; result?: { isError?: boolean } };
    await call({ prompt: "p", model: "claude-opus-5-5" });
    assert.deepEqual(got, [["c1", { prompt: "p", model: "claude-opus-5-5" }]]);
    const bad = await call({ prompt: "p", model: "a b" });
    assert.ok(bad.error !== undefined || bad.result?.isError === true);
    assert.equal(got.length, 1);
  } finally {
    setWorkerHandler(undefined);
    await l.close();
  }
});

test("agents: status の caps / workers に model（記録した値、無ければ null）", async () => {
  await withWs(async (ws, config) => {
    await mkdir(join(ws, "caps", "c2"), { recursive: true });
    const m = mgr(config, []);
    await m.invoke("cap", "c1", { prompt: "a", model: "opus" });
    await m.invoke("cap", "c2", { prompt: "a" });
    const st = await m.status();
    assert.deepEqual(st.caps.map((c) => [c.id, (c as { model?: unknown }).model]), [["c1", "opus"], ["c2", null]]);
  });
});

test("daemon: kick_cap の model / worker_model は manager.invoke にそのまま届く（無ければ付かない）", async () => {
  const { execute } = await import("../../../../server/utils/bantou/daemon");
  const seen: InvokeInput[] = [];
  const manager = { invoke: async (_k: string, _i: string, input: InvokeInput) => (seen.push(input), { session_id: "s", ok: true, result_text: "" }) };
  await execute({ bantou: 1, type: "kick_cap", cap_id: "c1", prompt: "p", model: "opus", worker_model: "haiku" } as never, manager as never);
  await execute({ bantou: 1, type: "kick_cap", cap_id: "c1", prompt: "p" } as never, manager as never);
  assert.deepEqual([seen[0]!.model, seen[0]!.worker_model], ["opus", "haiku"]);
  assert.deepEqual([seen[1]!.model, seen[1]!.worker_model], [undefined, undefined]);
});
