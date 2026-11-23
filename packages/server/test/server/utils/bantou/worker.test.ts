import { test } from "node:test";
import assert from "node:assert/strict";
import { lstat, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ClaudeRunOptions, ClaudeRunResult } from "../../../../server/utils/bantou/claude";
import { DEFAULT_SESSION, type Config } from "../../../../server/utils/bantou/config";
import { WORKER_GUIDE } from "../../../../server/utils/bantou/prompts";
import { WORKER_SCHEMA_JSON, type CapMessage, type CapReport } from "../../../../server/utils/bantou/result";
import type { AgentRunner } from "../../../../server/utils/bantou/runner";
import { readState } from "../../../../server/utils/bantou/state";
import type { Tracker, TrackerOptions } from "../../../../server/utils/bantou/tracker";
import { createWorkerJob, resumeInput, type WorkerDeps, type WorkerRunInput } from "../../../../server/utils/bantou/worker";

interface Rig {
  ws: string;
  runs: ClaudeRunOptions[];
  sent: Array<{ to: string; body: CapMessage | CapReport }>;
  trackers: Array<{ opts: TrackerOptions; touched: number; closed: boolean }>;
  deps: WorkerDeps;
  input: WorkerRunInput;
  cleanup(): Promise<void>;
}

async function rig(run: (o: ClaudeRunOptions) => Promise<ClaudeRunResult>, over: Partial<Config["session"]> = {}): Promise<Rig> {
  const ws = await mkdtemp(join(tmpdir(), "bantou-worker-test-"));
  const config: Config = {
    workspace: ws,
    broker: { port: 0, bind: "127.0.0.1", discovery: "off", token: "" },
    mcp: { port: 0, bind: "127.0.0.1" },
    session: { ...structuredClone(DEFAULT_SESSION), maxParallel: 2, ...over },
    extraMcp: {},
  };
  const runs: ClaudeRunOptions[] = [];
  const runner: AgentRunner = {
    run: (o) => {
      runs.push(o);
      return run(o);
    },
  };
  const sent: Rig["sent"] = [];
  const trackers: Rig["trackers"] = [];
  const deps: WorkerDeps = {
    config,
    runner,
    mcpUrl: () => "http://127.0.0.1:7902/mcp",
    sendToCap: async (to, body) => {
      sent.push({ to, body });
    },
    makeTracker: (opts): Tracker => {
      const t = { opts, touched: 0, closed: false };
      trackers.push(t);
      return { touch: () => void t.touched++, close: () => void (t.closed = true) };
    },
    log: () => {},
  };
  const input: WorkerRunInput = {
    workerId: "w-test1",
    dir: join(ws, "workers", "w-test1"),
    parentId: "cap-main",
    ws: "ws://127.0.0.1:1/center",
    model: "sonnet",
    mode: "new",
    sessionId: "11111111-1111-4111-8111-111111111111",
    prompt: "やること",
  };
  return { ws, runs, sent, trackers, deps, input, cleanup: () => rm(ws, { recursive: true, force: true }) };
}

const okResult = (so: unknown, sessionId = "22222222-2222-4222-8222-222222222222"): ClaudeRunResult => ({
  ok: true,
  sessionId,
  resultText: "",
  structuredOutput: so,
  durationMs: 1,
});

test("worker: launch の worker を起こし、report（success）を parent-id へ session-id 無しで返す。state.json を残す", async () => {
  const r = await rig(async (o) => {
    o.onLine?.("{}");
    return okResult({ lastType: "report", status: "success", content: "できた" });
  });
  try {
    let settled = 0;
    await createWorkerJob(r.deps, r.input, "launch", () => settled++).start();
    assert.equal(r.runs.length, 1);
    const o = r.runs[0] as ClaudeRunOptions;
    assert.equal(o.mode, "new");
    assert.equal(o.sessionId, r.input.sessionId);
    assert.equal(o.model, "sonnet");
    assert.equal(o.prompt, "やること");
    assert.equal(o.cwd, r.input.dir);
    assert.equal(o.jsonSchema, WORKER_SCHEMA_JSON);
    assert.deepEqual(o.extraAllowedTools, ["mcp__bantou__bash"], "report 道具は無い。bash だけ");
    assert.equal(o.env?.TMPDIR, join(r.input.dir, "tmp"));
    assert.ok((await lstat(join(r.input.dir, "tmp"))).isDirectory());
    // mcp 設定は bash（header で worker を判定）だけ
    const mcp = JSON.parse(await readFile(o.mcpConfigFile as string, "utf8")) as { mcpServers: Record<string, { headers: Record<string, string> }> };
    assert.deepEqual(Object.keys(mcp.mcpServers), ["bantou"]);
    assert.deepEqual(mcp.mcpServers.bantou?.headers, { "x-bantou-worker-id": "w-test1" });
    assert.equal(await readFile(o.appendSystemPromptFile as string, "utf8"), WORKER_GUIDE + "\n");
    // 返し先・中身
    assert.deepEqual(r.sent, [{ to: "cap-main", body: { status: "success", content: "できた" } }]);
    // tracker は session ごとに付き、出力で touch され、終わりで閉じる
    assert.equal(r.trackers.length, 1);
    assert.deepEqual({ parentId: r.trackers[0]?.opts.parentId, ws: r.trackers[0]?.opts.ws }, { parentId: "cap-main", ws: "ws://127.0.0.1:1/center" });
    assert.equal(r.trackers[0]?.touched, 1);
    assert.equal(r.trackers[0]?.closed, true);
    assert.equal(settled, 1);
    const st = await readState(r.input.dir);
    assert.equal(st?.parent_id, "cap-main");
    assert.equal(st?.ws, "ws://127.0.0.1:1/center");
    assert.equal(st?.model, "sonnet");
    assert.equal(st?.session_id, "22222222-2222-4222-8222-222222222222");
    assert.ok(st?.last_finished_at);
  } finally {
    await r.cleanup();
  }
});

const SCHEMA = { type: "http" as const, url: "http://10.0.0.5:7910/mcp/schemas", headers: { Authorization: "Bearer SECRETTOKEN" } };

test("worker: launch の schema と config の openspecUrl が両方在れば、openspec（x-schema-discovery = schema の JSON 文字列）と mcp__openspec__* を足す。state.json には schema を生のまま残す", async () => {
  const r = await rig(async () => okResult({ lastType: "report", status: "success", content: "x" }));
  try {
    r.deps.config.openspecUrl = "http://127.0.0.1:9000/mcp";
    const logs: string[] = [];
    r.deps.log = (m) => void logs.push(m);
    await createWorkerJob(r.deps, { ...r.input, schema: SCHEMA }, "launch").start();
    const o = r.runs[0] as ClaudeRunOptions;
    const mcp = JSON.parse(await readFile(o.mcpConfigFile as string, "utf8")) as { mcpServers: Record<string, { type: string; url: string; headers: Record<string, string> }> };
    assert.deepEqual(Object.keys(mcp.mcpServers), ["bantou", "openspec"]);
    assert.equal(mcp.mcpServers.openspec?.type, "http");
    assert.equal(mcp.mcpServers.openspec?.url, "http://127.0.0.1:9000/mcp");
    assert.deepEqual(mcp.mcpServers.openspec?.headers, { "x-schema-discovery": JSON.stringify(SCHEMA) });
    assert.deepEqual(o.extraAllowedTools, ["mcp__bantou__bash", "mcp__openspec__*"]);
    assert.deepEqual((await readState(r.input.dir))?.schema, SCHEMA);
    assert.ok(!logs.join("\n").includes("SECRETTOKEN"), "schema の認証の値は log に出ない");
  } finally {
    await r.cleanup();
  }
});

test("worker: openspecUrl が無い、または launch に schema が無ければ openspec を足さない", async () => {
  for (const [openspecUrl, schema] of [[undefined, SCHEMA], ["http://127.0.0.1:9000/mcp", undefined]] as const) {
    const r = await rig(async () => okResult({ lastType: "report", status: "success", content: "x" }));
    try {
      if (openspecUrl !== undefined) r.deps.config.openspecUrl = openspecUrl;
      await createWorkerJob(r.deps, { ...r.input, ...(schema !== undefined ? { schema } : {}) }, "launch").start();
      const o = r.runs[0] as ClaudeRunOptions;
      const mcp = JSON.parse(await readFile(o.mcpConfigFile as string, "utf8")) as { mcpServers: Record<string, unknown> };
      assert.deepEqual(Object.keys(mcp.mcpServers), ["bantou"]);
      assert.deepEqual(o.extraAllowedTools, ["mcp__bantou__bash"]);
    } finally {
      await r.cleanup();
    }
  }
});

test("worker: reply の起こし直し（resumeInput）も state.json の schema で openspec を足す", async () => {
  const r = await rig(async () => okResult({ lastType: "report", status: "success", content: "x" }));
  try {
    r.deps.config.openspecUrl = "http://127.0.0.1:9000/mcp";
    await createWorkerJob(r.deps, { ...r.input, schema: SCHEMA }, "launch").start();
    const again = await resumeInput(r.input.dir, "続き");
    assert.deepEqual(again?.schema, SCHEMA);
    await createWorkerJob(r.deps, again as WorkerRunInput, "reply").start();
    const o = r.runs[1] as ClaudeRunOptions;
    const mcp = JSON.parse(await readFile(o.mcpConfigFile as string, "utf8")) as { mcpServers: Record<string, unknown> };
    assert.deepEqual(Object.keys(mcp.mcpServers), ["bantou", "openspec"]);
  } finally {
    await r.cleanup();
  }
});

test("worker: message（ask）は session-id（最後の result の）付きで返る", async () => {
  const r = await rig(async () => okResult({ lastType: "message", status: "ask", content: "どちら？" }, "33333333-3333-4333-8333-333333333333"));
  try {
    await createWorkerJob(r.deps, r.input, "launch").start();
    assert.deepEqual(r.sent, [{ to: "cap-main", body: { "session-id": "33333333-3333-4333-8333-333333333333", status: "ask", content: "どちら？" } }]);
  } finally {
    await r.cleanup();
  }
});

test("worker: process が落ちて最後の出力が無ければ failed を付けて返す", async () => {
  const r = await rig(async () => ({ ok: false, sessionMissing: false, timedOut: false, detail: "終了コード 1", durationMs: 1 }));
  try {
    await createWorkerJob(r.deps, r.input, "launch").start();
    assert.equal(r.sent.length, 1);
    assert.equal(r.sent[0]?.body.status, "failed");
    assert.ok(!("session-id" in (r.sent[0]?.body ?? {})));
  } finally {
    await r.cleanup();
  }
});

test("worker: 準備で失敗（mcp 未起動）しても failed を返し、queue の枠を返す", async () => {
  const r = await rig(async () => okResult({ lastType: "report", status: "success", content: "x" }));
  try {
    r.deps.mcpUrl = () => undefined;
    let settled = 0;
    await createWorkerJob(r.deps, r.input, "launch", () => settled++).start();
    assert.equal(r.runs.length, 0);
    assert.equal(r.sent[0]?.body.status, "failed");
    assert.equal(r.trackers[0]?.closed, true);
    assert.equal(settled, 1);
  } finally {
    await r.cleanup();
  }
});

test("worker: cap への返信が失敗しても落ちない", async () => {
  const r = await rig(async () => okResult({ lastType: "report", status: "success", content: "x" }));
  try {
    r.deps.sendToCap = async () => {
      throw new Error("Name is ambiguous");
    };
    await createWorkerJob(r.deps, r.input, "launch").start();
  } finally {
    await r.cleanup();
  }
});

test("worker: stop（abort）で止めた worker の結果は cap へ送らない。起こす前に止めれば起こさない", async () => {
  let release!: () => void;
  const gate = new Promise<void>((res) => (release = res));
  const r = await rig(async () => {
    await gate;
    return okResult({ lastType: "report", status: "success", content: "x" });
  });
  try {
    const job = createWorkerJob(r.deps, r.input, "launch");
    const p = job.start();
    await new Promise((res) => setTimeout(res, 20));
    job.abort();
    release();
    await p;
    assert.deepEqual(r.sent, []);
    assert.equal(r.trackers[0]?.closed, true);

    const r2 = await rig(async () => okResult({ lastType: "report", status: "success", content: "x" }));
    try {
      const j2 = createWorkerJob(r2.deps, r2.input, "launch");
      j2.abort();
      await j2.start();
      assert.equal(r2.runs.length, 0);
      assert.deepEqual(r2.sent, []);
    } finally {
      await r2.cleanup();
    }
  } finally {
    await r.cleanup();
  }
});

test("worker: reply の起こし直しは state.json の session / cap / ws / model で --resume し、同じ cwd で動く", async () => {
  const r = await rig(async () => okResult({ lastType: "report", status: "success", content: "1 回目" }));
  try {
    await createWorkerJob(r.deps, r.input, "launch").start();
    const again = await resumeInput(r.input.dir, "A案で");
    assert.ok(again);
    assert.equal(again.mode, "resume");
    assert.equal(again.sessionId, "22222222-2222-4222-8222-222222222222");
    assert.equal(again.parentId, "cap-main");
    assert.equal(again.ws, "ws://127.0.0.1:1/center");
    assert.equal(again.model, "sonnet");
    assert.equal(again.dir, r.input.dir);
    assert.equal(again.prompt, "A案で");
    await createWorkerJob(r.deps, again, "reply").start();
    const o = r.runs[1] as ClaudeRunOptions;
    assert.equal(o.mode, "resume");
    assert.equal(o.sessionId, "22222222-2222-4222-8222-222222222222");
    assert.equal(o.cwd, r.input.dir);
    assert.equal(o.prompt, "A案で");
    assert.equal(r.sent.length, 2);
    assert.equal(await resumeInput(join(r.ws, "workers", "none"), "x"), undefined);
  } finally {
    await r.cleanup();
  }
});
