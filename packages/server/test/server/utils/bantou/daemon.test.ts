import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareWorkspace } from "../../../../server/utils/bantou/workspace";
import { REPLY_META, classifyMeta, commandCapId, describeCommand, execute, executeUpdate, maskUserinfo, updatingError } from "../../../../server/utils/bantou/daemon";
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
  const dir = new URL("../../../../../protocol/messenger/", import.meta.url);
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

import type { TaskCommand } from "@agent-hand/bantou-protocol";

const taskCmd: TaskCommand = {
  bantou: 1, type: "task", cap_id: "c1", task_id: "t-1", goal: "やること",
  repo: "https://u:pw@example.com/o/r.git", branch: "main",
  deliverables: {}, verify: {}, constraints: [], workers: {}, worker_model: "sonnet",
};

test("task: cap の最初の指示を組み立てて invoke し、task_result で返す", async () => {
  const calls: Array<[string, string, Record<string, unknown>]> = [];
  const manager = {
    invoke: async (k: string, id: string, input: Record<string, unknown>) => {
      calls.push([k, id, input]);
      return { session_id: "s", ok: true, result_text: '{"summary":"できた","review":{"verdict":"ok","items":[],"rounds":1}}' };
    },
  } as unknown as AgentManager;
  const r = await execute(taskCmd, manager);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]![0], "cap");
  assert.equal(calls[0]![1], "c1");
  assert.ok(String(calls[0]![2].prompt).startsWith("[task t-1]\n"));
  assert.ok(String(calls[0]![2].prompt).includes("やること"));
  // repo / branch は cap の dir に clone されない（cap は git を触らない）。文面にだけ載る
  assert.equal(calls[0]![2].repo, undefined);
  assert.equal(calls[0]![2].branch, undefined);
  assert.ok(String(calls[0]![2].prompt).includes("repo: https://u:pw@example.com/o/r.git"));
  assert.ok(String(calls[0]![2].prompt).includes("branch: main"));
  assert.equal(calls[0]![2].worker_model, "sonnet");
  assert.equal(r.type, "task_result");
  assert.equal((r as { summary: string }).summary, "できた");
  assert.equal((r as { review: { verdict: string; rounds: number } }).review.verdict, "ok");
  assert.equal((r as { review: { rounds: number } }).review.rounds, 1);
});

test("task: 生の返答は summary に入り verdict は unknown。失敗は error（cap_id と task_id 付き）", async () => {
  const raw = await execute(taskCmd, { invoke: async () => ({ session_id: "s", ok: true, result_text: "起動した" }) } as unknown as AgentManager);
  assert.deepEqual(raw, {
    bantou: 1, type: "task_result", cap_id: "c1", task_id: "t-1", state: "done", summary: "起動した",
    workers: [], review: { verdict: "unknown", items: [], rounds: 0 }, remaining: [],
  });
  const failed = await execute(taskCmd, { invoke: async () => ({ session_id: "s", ok: false, result_text: "", error: "exit 1" }) } as unknown as AgentManager);
  assert.equal((failed as { state: string }).state, "failed");
  assert.equal((failed as { error: string }).error, "exit 1");
  const err = await execute(taskCmd, { invoke: async () => { throw new Error("boom"); } } as unknown as AgentManager);
  assert.deepEqual(err, { bantou: 1, type: "error", ok: false, message: "boom", command: "task", cap_id: "c1", task_id: "t-1" });
});

test("task: ログ概要は task_id・goal 先頭・repo の userinfo を伏せる", () => {
  const line = describeCommand({ ...taskCmd, goal: "g".repeat(200) });
  assert.ok(line.includes("cap_id=c1 task_id=t-1"));
  assert.ok(line.includes("repo=https://***@example.com/o/r.git"));
  assert.ok(!line.includes("pw"));
  assert.ok(line.includes("workers=0"));
  assert.ok(line.includes(`goal=${"g".repeat(80)}`) && !line.includes("g".repeat(81)));
});

test("task: 更新待機中の断りは command=task、task_id 付き。kick_cap は従来どおり", () => {
  const t = updatingError({ cap_id: "c1", task_id: "t-1" }, { from: "0.6.0", to: "0.6.1" });
  assert.equal((t as { command?: string }).command, "task");
  assert.equal((t as { task_id?: string }).task_id, "t-1");
  assert.equal((t as { code?: string }).code, "updating");
  const k = updatingError({ cap_id: "c1" }, { from: "0.6.0", to: "0.6.1" });
  assert.equal((k as { command?: string }).command, "kick_cap");
  assert.equal("task_id" in k, false);
});

test("worker_reply: 同じ worker_id で worker_start し、worker_reply_result を返す", async () => {
  const calls: unknown[] = [];
  const workers = { start: async (capId: string, input: unknown) => (calls.push([capId, input]), { worker_id: "w-1", accepted: true as const }) };
  const cmd = { bantou: 1 as const, type: "worker_reply" as const, cap_id: "c1", worker_id: "w-1", text: "main に rebase して" };
  const r = await execute(cmd, {} as unknown as AgentManager, workers);
  assert.deepEqual(r, { bantou: 1, type: "worker_reply_result", ok: true, cap_id: "c1", worker_id: "w-1", accepted: true });
  assert.deepEqual(calls, [["c1", { worker_id: "w-1", prompt: "main に rebase して" }]]);
  assert.equal(describeCommand(cmd), "cap_id=c1 worker_id=w-1 text=main に rebase して");
});

test("worker_reply: 失敗は error（cap_id・worker_id 付き）。worker 機構が無い間も error", async () => {
  const cmd = { bantou: 1 as const, type: "worker_reply" as const, cap_id: "c1", worker_id: "w-1", text: "x" };
  const e1 = await execute(cmd, {} as unknown as AgentManager, { start: async () => { throw new Error("別の cap の worker: w-1"); } });
  assert.deepEqual(e1, { bantou: 1, type: "error", ok: false, message: "別の cap の worker: w-1", command: "worker_reply", cap_id: "c1", worker_id: "w-1" });
  const e2 = await execute(cmd, {} as unknown as AgentManager);
  assert.equal(e2.type, "error");
  assert.equal((e2 as { command?: string }).command, "worker_reply");
});

test("protocol 1.6.0: 返信 meta と hello の版は 1.6.0（1.5.0 の center / server とは版違いになる）", () => {
  assert.equal(REPLY_META.version, "1.6.0");
});

test("commandCapId: cap を指す命令は cap_id、status は cap_id 付きの時だけ。hello / update_server は無し", () => {
  assert.equal(commandCapId({ bantou: 1, type: "kick_cap", cap_id: "c1", prompt: "p" }), "c1");
  assert.equal(commandCapId({ bantou: 1, type: "stop_cap", cap_id: "c2" }), "c2");
  assert.equal(commandCapId({ bantou: 1, type: "worker_reply", cap_id: "c3", worker_id: "w", text: "x" }), "c3");
  assert.equal(commandCapId({ bantou: 1, type: "status", cap_id: "c4" }), "c4");
  assert.equal(commandCapId({ bantou: 1, type: "status" }), undefined);
  assert.equal(commandCapId({ bantou: 1, type: "hello" }), undefined);
  assert.equal(commandCapId({ bantou: 1, type: "update_server", version: "0.6.0" }), undefined);
  assert.equal(describeCommand({ bantou: 1, type: "status", cap_id: "c4" }), "cap_id=c4");
  assert.equal(describeCommand({ bantou: 1, type: "status" }), "");
});
