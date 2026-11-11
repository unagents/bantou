import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryQueue, type MemoryEvent, type MemorySink, type MemoryTarget, type TaskCommand } from "@agent-hand/bantou-protocol";
import { createServerMemory, createServerMemorySink } from "../../../../server/utils/bantou/memory";
import { createReportHub } from "../../../../server/utils/bantou/reports";
import { describeCommand, ignoreText } from "../../../../server/utils/bantou/daemon";
import { startFakeMemory } from "../../../helpers/fake-memory";

const task = (over: Partial<TaskCommand> = {}): TaskCommand => ({
  bantou: 1, type: "task", cap_id: "c-x-pm1", task_id: "t-1", goal: "do it", deliverables: {}, verify: {}, constraints: [], workers: {},
  memory: { url: "http://mem/mcp", token: "TKN", agent_id: "c-x-pm1", session: "pm1" }, ...over,
} as TaskCommand);
const tr = (summary: string, task_id = "t-1") => ({ bantou: 1, type: "task_result", cap_id: "c-x-pm1", task_id, state: "done", summary, workers: [], review: { verdict: "unknown", items: [], rounds: 0 }, remaining: [] });

function setup() {
  const sent: { target: MemoryTarget; event: MemoryEvent }[] = [];
  const logs: string[] = [];
  const sink: MemorySink = { send: async (target, event) => void sent.push({ target, event }) };
  const mem = createServerMemory({ log: (l) => logs.push(l), sink });
  return { mem, sent, logs };
}

test("task: memory があれば cap の記憶（agent = memory.agent_id）へ task event を積む。eventId は s1 名前空間", async () => {
  const { mem, sent } = setup();
  mem.onTask(task());
  await mem.drain(500);
  assert.equal(sent.length, 1);
  const { target, event } = sent[0]!;
  assert.deepEqual(target, { url: "http://mem/mcp", token: "TKN", agentId: "c-x-pm1" });
  assert.equal(event.kind, "task");
  assert.equal(event.eventId, "s1:c-x-pm1:task:t-1");
  assert.deepEqual([event.sender, event.recipient, event.remoteId, event.taskId], [{ session: "pm1" }, { capId: "c-x-pm1" }, "c-x-pm1", "t-1"]);
  assert.equal(event.body, "do it");
  mem.close();
});

test("memory が無い task（古い center・設定なし）: 何も積まない。壊れた memory も無視（task は止めない）。agent_id 省略時は cap_id", async () => {
  const { mem, sent } = setup();
  mem.onTask(task({ memory: undefined }));
  mem.onTask(task({ memory: { url: "ftp://x" } as never }));
  mem.onTask(task({ memory: "junk" as never }));
  mem.onReport("c-x-pm1", "w1", "done", "x", "2026-11-11T00:00:00.000Z");
  await mem.drain(200);
  assert.equal(sent.length, 0);
  mem.onTask(task({ memory: { url: "http://mem/mcp" } as never }));
  await mem.drain(500);
  assert.equal(sent[0]!.target.agentId, "c-x-pm1");
  assert.equal(sent[0]!.target.token, undefined);
  mem.close();
});

test("次の task が memory 無しなら、その cap の書き込みを止める（置き換え・消去）", async () => {
  const { mem, sent } = setup();
  mem.onTask(task());
  mem.onTask(task({ task_id: "t-2", memory: undefined }));
  mem.onReport("c-x-pm1", "w1", "done", "x", "2026-11-11T00:00:00.000Z");
  await mem.drain(500);
  assert.deepEqual(sent.map((s) => s.event.kind), ["task"]);
  mem.close();
});

test("report / reply / result: 種別・送り手・受け手。cap_result と task_result は result、error は記録しない", async () => {
  const { mem, sent } = setup();
  mem.onTask(task());
  mem.onReport("c-x-pm1", "w-1", "ask", "which?", "2026-11-11T01:00:00.000Z", "t-1");
  mem.onWorkerReply("c-x-pm1", "w-1", "this one");
  mem.onResult(tr("fine"));
  mem.onResult({ type: "cap_result", cap_id: "c-x-pm1", ok: true, result_text: "plain", session_id: "s" } as never);
  mem.onResult({ type: "error", cap_id: "c-x-pm1" });
  mem.onResult({ type: "stop_result", cap_id: "c-x-pm1" });
  await mem.drain(500);
  assert.deepEqual(sent.map((s) => s.event.kind), ["task", "report", "reply", "result", "result"]);
  const [, rp, rl, rs, cr] = sent.map((s) => s.event);
  assert.deepEqual([rp!.sender, rp!.recipient, rp!.body, rp!.at], [{ workerId: "w-1" }, { capId: "c-x-pm1" }, "(ask) which?", "2026-11-11T01:00:00.000Z"]);
  assert.deepEqual([rl!.sender, rl!.recipient, rl!.body], [{ session: "pm1" }, { workerId: "w-1" }, "this one"]);
  assert.deepEqual([rs!.sender, rs!.recipient, rs!.taskId], [{ capId: "c-x-pm1" }, { session: "pm1" }, "t-1"]);
  assert.equal(cr!.body, "plain");
  assert.ok(sent.every((s) => s.event.eventId.startsWith("s1:c-x-pm1:")));
  mem.close();
});

test("二重送信しない: 同じ出来事を 1 回の呼び出しで 1 event。同じ結果の再通知は同じ eventId、別の結果は別の eventId", async () => {
  const { mem, sent } = setup();
  mem.onTask(task());
  mem.onResult(tr("A"));
  mem.onResult(tr("A"));
  mem.onResult(tr("B"));
  await mem.drain(500);
  const ids = sent.filter((s) => s.event.kind === "result").map((s) => s.event.eventId);
  assert.equal(ids[0], ids[1]);
  assert.notEqual(ids[0], ids[2]);
  assert.equal(sent.filter((s) => s.event.kind === "task").length, 1);
  mem.close();
});

test("hub: report は 1 回の report で report event を 1 件、report 起因の結果で result event を 1 件（center が不明でも cap の記憶には書く）", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bantou-mem-test-"));
  try {
    const ws = join(dir, "ws");
    await mkdir(join(ws, "caps", "c-x-pm1"), { recursive: true });
    const { mem, sent } = setup();
    mem.onTask(task());
    const hub = createReportHub({
      workspace: ws,
      memory: mem,
      invoke: async () => ({ session_id: "s", ok: true, result_text: "cap says" }),
      send: async () => {},
      log: () => {},
    });
    await hub.report("c-x-pm1", "w-1", "done", "finished");
    await hub.drain();
    await mem.drain(500);
    assert.deepEqual(sent.map((s) => s.event.kind), ["task", "report", "result"]);
    mem.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("fake memory と実 MCP client: header（Bearer / X-Agent-Id）で届き、memory が落ちていても投げず、token は log に出ない", async () => {
  const fake = await startFakeMemory();
  const logs: string[] = [];
  try {
    const queue = createMemoryQueue({ sink: createServerMemorySink(), log: (l) => logs.push(l), baseMs: 10, maxMs: 40 });
    const mem = createServerMemory({ log: (l) => logs.push(l), queue });
    fake.setDown(true);
    mem.onTask(task({ memory: { url: fake.url, token: fake.token, agent_id: "cap-agent", session: "pm1" } }));
    mem.onReport("c-x-pm1", "w-1", "done", "secret-report-body", "2026-11-11T00:00:00.000Z");
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(fake.recorded().length, 0);
    fake.setDown(false);
    const t0 = Date.now();
    while (fake.recorded().length < 2 && Date.now() - t0 < 4000) await new Promise((r) => setTimeout(r, 10));
    assert.deepEqual(fake.recorded().map((e) => [e.kind, e.agentId]), [["task", "cap-agent"], ["report", "cap-agent"]]);
    assert.ok(fake.calls.every((c) => c.authorization === `Bearer ${fake.token}`));
    assert.ok(logs.length > 0);
    const hay = logs.join("\n");
    assert.ok(!hay.includes(fake.token) && !hay.includes("secret-report-body"));
    mem.close();
  } finally {
    await fake.close();
  }
});

test("log に token が出ない: describeCommand は memory を含めない。ignoreText は \"token\" の値を伏せる", () => {
  const cmd = task({ memory: { url: "http://mem/mcp", token: "SUPER-SECRET", agent_id: "a" } });
  assert.ok(!describeCommand(cmd).includes("SUPER-SECRET"));
  assert.ok(!ignoreText(JSON.stringify(cmd)).includes("SUPER-SECRET"));
  assert.ok(!ignoreText('{"memory":{"url":"u","token" : "SUPER-SECRET"}}').includes("SUPER-SECRET"));
});

test("report の eventId: server の at と worker が同じでも本文が違えば別 id（digest を外すと同じ id になる）", async () => {
  const { mem, sent } = setup();
  mem.onTask(task());
  mem.onReport("c-x-pm1", "w-1", "done", "first", "2026-11-11T00:00:00.000Z");
  mem.onReport("c-x-pm1", "w-1", "done", "second", "2026-11-11T00:00:00.000Z");
  await mem.drain(500);
  const ids = sent.filter((s) => s.event.kind === "report").map((s) => s.event.eventId);
  assert.equal(ids.length, 2);
  assert.notEqual(ids[0], ids[1]);
  mem.close();
});
