import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunOutcome, ServerReply } from "@agent-hand/bantou-protocol";
import type { AgentManager, InvokeInput } from "../../../../server/utils/bantou/agents";
import { createFlow, reportPrompt, workerFailurePrompt } from "../../../../server/utils/bantou/flow";
import { readOwner, readReplyTo } from "../../../../server/utils/bantou/links";

interface Call {
  kind: string;
  id: string;
  input: InvokeInput;
}

async function withFlow(
  invoke: (kind: string, id: string, input: InvokeInput) => Promise<RunOutcome>,
  fn: (t: {
    ws: string;
    flow: ReturnType<typeof createFlow>;
    calls: Call[];
    sent: { to: string; reply: ServerReply }[];
    logs: string[];
    idle: () => Promise<void>;
    setClosing: () => void;
  }) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "bantou-flow-test-"));
  try {
    const ws = join(dir, "ws");
    await mkdir(join(ws, "caps"), { recursive: true });
    await mkdir(join(ws, "workers"), { recursive: true });
    const calls: Call[] = [];
    const sent: { to: string; reply: ServerReply }[] = [];
    const logs: string[] = [];
    const tracked = new Set<Promise<void>>();
    let closing = false;
    const manager = {
      invoke: (kind: string, id: string, input: InvokeInput) => {
        calls.push({ kind, id, input });
        return invoke(kind, id, input);
      },
    } as unknown as AgentManager;
    const flow = createFlow({
      manager,
      workspace: ws,
      log: (m) => logs.push(m),
      send: async (to, reply) => {
        sent.push({ to, reply });
      },
      isClosing: () => closing,
      track: (p) => {
        const q: Promise<void> = p.finally(() => tracked.delete(q));
        tracked.add(q);
      },
    });
    const idle = async (): Promise<void> => {
      while (tracked.size > 0) await Promise.allSettled([...tracked]);
    };
    await fn({ ws, flow, calls, sent, logs, idle, setClosing: () => (closing = true) });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const okOutcome = (text: string): RunOutcome => ({ session_id: "s", ok: true, result_text: text });

test("flow: spawn_worker は worker を起動し owner.json 用 sidecar を渡す", async () => {
  await withFlow(async () => okOutcome("w done"), async (t) => {
    t.flow.spawnWorker({
      bantou: 1, type: "spawn_worker", worker_id: "w1", cap_id: "c1", prompt: "echo hi", repo: "r", branch: "b",
    });
    await t.idle();
    assert.equal(t.calls.length, 1);
    assert.equal(t.calls[0].kind, "worker");
    assert.equal(t.calls[0].id, "w1");
    assert.equal(t.calls[0].input.prompt, "echo hi");
    assert.equal(t.calls[0].input.repo, "r");
    assert.equal(t.calls[0].input.branch, "b");
    assert.deepEqual(t.calls[0].input.sidecar, { name: "owner.json", data: { cap_id: "c1" } });
    assert.equal(t.sent.length, 0);
  });
});

test("flow: worker の起動失敗・実行失敗は cap を resume して知らせる", async () => {
  for (const mode of ["throw", "notok"]) {
    await withFlow(
      async (kind) => {
        if (kind === "worker") {
          if (mode === "throw") throw new Error("clone failed");
          return { session_id: "s", ok: false, result_text: "", error: "timeout" };
        }
        return okOutcome("cap again");
      },
      async (t) => {
        await mkdir(join(t.ws, "caps", "c1"), { recursive: true });
        await writeFile(join(t.ws, "caps", "c1", "reply_to.json"), JSON.stringify({ id: "p1", name: "ext" }));
        t.flow.spawnWorker({ bantou: 1, type: "spawn_worker", worker_id: "w1", cap_id: "c1", prompt: "x" });
        await t.idle();
        const cap = t.calls.find((c) => c.kind === "cap");
        assert.ok(cap, mode);
        assert.equal(cap.id, "c1");
        assert.equal(cap.input.prompt, workerFailurePrompt("w1", mode === "throw" ? "clone failed" : "timeout"));
        assert.equal(t.sent.length, 1);
      },
    );
  }
});

test("flow: worker_report は owner の cap を resume し、reply_to へ cap_result を送る", async () => {
  await withFlow(async () => okOutcome("cap final"), async (t) => {
    await mkdir(join(t.ws, "workers", "w1"), { recursive: true });
    await writeFile(join(t.ws, "workers", "w1", "owner.json"), JSON.stringify({ cap_id: "c1" }));
    await mkdir(join(t.ws, "caps", "c1"), { recursive: true });
    await writeFile(join(t.ws, "caps", "c1", "reply_to.json"), JSON.stringify({ id: "peer9", name: "ext" }));
    const cmd = { bantou: 1, type: "worker_report", worker_id: "w1", kind: "ask", text: "which?" } as const;
    assert.equal(await t.flow.workerReport(cmd), undefined);
    await t.idle();
    assert.equal(t.calls.length, 1);
    assert.equal(t.calls[0].kind, "cap");
    assert.equal(t.calls[0].id, "c1");
    assert.equal(t.calls[0].input.prompt, reportPrompt(cmd));
    assert.ok(t.calls[0].input.prompt.includes("which?"));
    assert.ok(t.calls[0].input.prompt.includes("resume_worker"));
    assert.equal(t.calls[0].input.sidecar, undefined);
    assert.deepEqual(t.sent, [
      { to: "peer9", reply: { bantou: 1, type: "cap_result", cap_id: "c1", session_id: "s", ok: true, result_text: "cap final" } },
    ]);
  });
});

test("flow: reply_to が無ければ cap_result は送らずログだけ", async () => {
  await withFlow(async () => okOutcome("x"), async (t) => {
    await mkdir(join(t.ws, "workers", "w1"), { recursive: true });
    await writeFile(join(t.ws, "workers", "w1", "owner.json"), JSON.stringify({ cap_id: "c1" }));
    await t.flow.workerReport({ bantou: 1, type: "worker_report", worker_id: "w1", kind: "done", text: "ok" });
    await t.idle();
    assert.equal(t.sent.length, 0);
    assert.ok(t.logs.some((l) => l.includes("送り先なし")));
  });
});

test("flow: owner 不明・壊れた owner.json の worker_report は error を返し cap を起動しない", async () => {
  await withFlow(async () => okOutcome("x"), async (t) => {
    const cmd = { bantou: 1, type: "worker_report", worker_id: "w1", kind: "done", text: "ok" } as const;
    const e1 = await t.flow.workerReport(cmd);
    assert.equal(e1?.type, "error");
    assert.equal(e1?.command, "worker_report");
    assert.equal(e1?.worker_id, "w1");
    await mkdir(join(t.ws, "workers", "w1"), { recursive: true });
    await writeFile(join(t.ws, "workers", "w1", "owner.json"), "{bad");
    const e2 = await t.flow.workerReport(cmd);
    assert.equal(e2?.type, "error");
    assert.equal(t.calls.length, 0);
  });
});

test("flow: 終了中は cap を再開しない", async () => {
  await withFlow(async () => okOutcome("x"), async (t) => {
    await mkdir(join(t.ws, "workers", "w1"), { recursive: true });
    await writeFile(join(t.ws, "workers", "w1", "owner.json"), JSON.stringify({ cap_id: "c1" }));
    t.setClosing();
    await t.flow.workerReport({ bantou: 1, type: "worker_report", worker_id: "w1", kind: "done", text: "ok" });
    await t.idle();
    assert.equal(t.calls.length, 0);
  });
});

test("links: readOwner / readReplyTo", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bantou-links-test-"));
  try {
    assert.equal(await readOwner(dir), null);
    assert.equal(await readReplyTo(dir), null);
    await writeFile(join(dir, "owner.json"), JSON.stringify({ cap_id: "../x" }));
    await assert.rejects(readOwner(dir), /cap_id が不正/);
    await writeFile(join(dir, "reply_to.json"), JSON.stringify({ id: "", name: "n" }));
    await assert.rejects(readReplyTo(dir), /形が不正/);
    await writeFile(join(dir, "reply_to.json"), JSON.stringify({ id: "p", name: "n" }));
    assert.deepEqual(await readReplyTo(dir), { id: "p", name: "n" });
    assert.equal((await readFile(join(dir, "reply_to.json"), "utf8")).includes('"p"'), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
