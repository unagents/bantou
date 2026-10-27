import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentManager } from "../src/agents.js";
import type { ClaudeRunOptions, ClaudeRunResult } from "../src/claude.js";
import { DEFAULT_SESSION, type Config } from "../src/config.js";
import type { AgentRunner } from "../src/runner.js";
import { readState, writeState } from "../src/state.js";

const ok = (text: string): ClaudeRunResult => ({ ok: true, sessionId: "x", resultText: text, durationMs: 1 });
const ng = (detail: string, extra: { sessionMissing?: boolean; timedOut?: boolean } = {}): ClaudeRunResult => ({
  ok: false,
  sessionMissing: extra.sessionMissing ?? false,
  timedOut: extra.timedOut ?? false,
  detail,
  durationMs: 1,
});

interface Fixture {
  ws: string;
  config: Config;
  calls: ClaudeRunOptions[];
  logs: string[];
}

async function withFixture(
  maxRetries: number,
  fn: (f: Fixture) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "bantou-agents-test-"));
  try {
    const ws = join(dir, "ws");
    await mkdir(join(ws, "caps"), { recursive: true });
    await mkdir(join(ws, "workers"), { recursive: true });
    const config: Config = {
      workspace: ws,
      broker: { port: 0, bind: "127.0.0.1", discovery: "off", token: "" },
      session: { ...structuredClone(DEFAULT_SESSION), maxRetries },
    };
    await fn({ ws, config, calls: [], logs: [] });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function mgr(f: Fixture, run: (o: ClaudeRunOptions) => Promise<ClaudeRunResult>, extra = {}) {
  const runner: AgentRunner = {
    run: (o) => {
      f.calls.push(o);
      return run(o);
    },
  };
  return createAgentManager({ config: f.config, runner, log: (m) => f.logs.push(m), ...extra });
}

test("agents: 初回は new で session_id を保存、2 回目は同じ id で resume", async () => {
  await withFixture(1, async (f) => {
    const m = mgr(f, async () => ok("hi"));
    const r1 = await m.invoke("cap", "c1", { prompt: "p1" });
    assert.equal(r1.ok, true);
    assert.equal(r1.result_text, "hi");
    assert.equal(f.calls[0].mode, "new");
    assert.equal(f.calls[0].sessionId, r1.session_id);
    assert.equal(f.calls[0].cwd, join(f.ws, "caps", "c1"));
    assert.ok(f.calls[0].logFile?.endsWith(`/logs/${r1.session_id}.jsonl`));
    const st = await readState(join(f.ws, "caps", "c1"));
    assert.equal(st.session_id, r1.session_id);
    assert.equal(st.state, "idle");
    assert.equal(st.retries, 0);
    assert.ok(st.last_started_at && st.last_finished_at);

    const r2 = await m.invoke("cap", "c1", { prompt: "p2" });
    assert.equal(f.calls[1].mode, "resume");
    assert.equal(r2.session_id, r1.session_id);
    assert.ok(f.logs.some((l) => l.includes("mode=resume") && l.includes(r1.session_id)));
  });
});

test("agents: resume で session 無しなら新しい id の new に切り替える", async () => {
  await withFixture(0, async (f) => {
    let n = 0;
    const m = mgr(f, async () => (++n === 2 ? ng("No conversation found", { sessionMissing: true }) : ok("r")));
    const r1 = await m.invoke("worker", "w1", { prompt: "a" });
    const r2 = await m.invoke("worker", "w1", { prompt: "b" });
    assert.equal(r2.ok, true);
    assert.notEqual(r2.session_id, r1.session_id);
    assert.deepEqual(f.calls.map((c) => c.mode), ["new", "resume", "new"]);
    assert.equal(f.calls[2].sessionId, r2.session_id);
    const st = await readState(join(f.ws, "workers", "w1"));
    assert.equal(st.session_id, r2.session_id);
    assert.equal(st.retries, 0);
  });
});

test("agents: タイムアウトは maxRetries まで再試行して failed", async () => {
  await withFixture(1, async (f) => {
    const m = mgr(f, async () => ng("タイムアウト (1ms)", { timedOut: true }));
    const r = await m.invoke("cap", "c1", { prompt: "p" });
    assert.equal(r.ok, false);
    assert.equal(r.error, "タイムアウト (1ms)");
    assert.equal(f.calls.length, 2);
    const st = await readState(join(f.ws, "caps", "c1"));
    assert.equal(st.state, "failed");
    assert.equal(st.last_error, "タイムアウト (1ms)");
    assert.equal(st.retries, 1);
  });
});

test("agents: 再試行で成功すれば idle、retries を記録", async () => {
  await withFixture(1, async (f) => {
    let n = 0;
    const m = mgr(f, async () => (++n === 1 ? ng("claude を起動できない: x") : ok("fine")));
    const r = await m.invoke("cap", "c1", { prompt: "p" });
    assert.equal(r.ok, true);
    const st = await readState(join(f.ws, "caps", "c1"));
    assert.equal(st.state, "idle");
    assert.equal(st.retries, 1);
    assert.equal(st.last_error, undefined);
  });
});

test("agents: 再試行対象外の失敗は 1 回で failed", async () => {
  await withFixture(3, async (f) => {
    const m = mgr(f, async () => ng("boom"));
    const r = await m.invoke("cap", "c1", { prompt: "p" });
    assert.equal(r.ok, false);
    assert.equal(f.calls.length, 1);
  });
});

test("agents: 同一 id は直列、別 id は並行、status に queued", async () => {
  await withFixture(0, async (f) => {
    const order: string[] = [];
    const gates = new Map<string, () => void>();
    const m = mgr(f, (o) => {
      order.push(`start:${o.prompt}`);
      return new Promise<ClaudeRunResult>((resolve) => {
        gates.set(o.prompt, () => {
          order.push(`end:${o.prompt}`);
          resolve(ok(o.prompt));
        });
      });
    });
    const until = async (cond: () => boolean): Promise<void> => {
      for (let i = 0; i < 200 && !cond(); i++) await new Promise((r) => setTimeout(r, 10));
    };
    const a1 = m.invoke("cap", "a", { prompt: "a1" });
    const a2 = m.invoke("cap", "a", { prompt: "a2" });
    const b1 = m.invoke("cap", "b", { prompt: "b1" });
    await until(() => order.length >= 2);
    await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual([...order].sort(), ["start:a1", "start:b1"]);

    const st = await m.status();
    const a = st.caps.find((c) => c.id === "a")!;
    const b = st.caps.find((c) => c.id === "b")!;
    assert.equal(a.state, "running");
    assert.equal(a.queued, 1);
    assert.equal(b.queued, 0);
    assert.equal(a.path, join(f.ws, "caps", "a"));

    gates.get("a1")!();
    await a1;
    await until(() => order.includes("start:a2"));
    assert.deepEqual(order.slice(2), ["end:a1", "start:a2"]);
    gates.get("a2")!();
    gates.get("b1")!();
    await Promise.all([a2, b1]);
  });
});

test("agents: status は cap と worker を列挙し、壊れた state は error", async () => {
  await withFixture(0, async (f) => {
    const m = mgr(f, async () => ok("x"));
    await m.invoke("cap", "c1", { prompt: "p" });
    await m.invoke("worker", "w1", { prompt: "p" });
    await mkdir(join(f.ws, "caps", "broken"), { recursive: true });
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(f.ws, "caps", "broken", "state.json"), "{x");
    const st = await m.status();
    assert.deepEqual(st.caps.map((c) => [c.id, c.state]), [["broken", "error"], ["c1", "idle"]]);
    assert.ok(st.caps[0].last_error?.includes("state.json"));
    assert.deepEqual(st.workers.map((c) => [c.id, c.state, c.queued]), [["w1", "idle", 0]]);
  });
});

test("agents: 不正な id は reject", async () => {
  await withFixture(0, async (f) => {
    const m = mgr(f, async () => ok("x"));
    await assert.rejects(m.invoke("cap", "../x", { prompt: "p" }), /cap_id が不正/);
    await assert.rejects(m.invoke("worker", "a b", { prompt: "p" }), /worker_id が不正/);
  });
});

test("agents: repo 指定で path が git repo でなければ投げて failed を記録", async () => {
  await withFixture(0, async (f) => {
    const m = mgr(f, async () => ok("x"));
    await mkdir(join(f.ws, "caps", "c1"), { recursive: true });
    await assert.rejects(m.invoke("cap", "c1", { prompt: "p", repo: "https://example.invalid/r.git" }), /git repo でない/);
    const st = await readState(join(f.ws, "caps", "c1"));
    assert.equal(st.state, "failed");
    assert.equal(f.calls.length, 0);
  });
});

async function seedRunning(f: Fixture, kind: "caps" | "workers", id: string, sid: string): Promise<string> {
  const dir = join(f.ws, kind, id);
  await writeState(dir, {
    session_id: sid,
    state: "running",
    last_started_at: "2026-01-01T00:00:00.000Z",
    last_finished_at: null,
    retries: 0,
  });
  return dir;
}

test("agents: reapOrphans はプロセス無しの running を failed にする", async () => {
  await withFixture(0, async (f) => {
    const dir = await seedRunning(f, "caps", "c1", "sid-a");
    await seedRunning(f, "workers", "w1", "sid-b");
    const m = mgr(f, async () => ok("x"), {
      listProcesses: async () => [{ pid: 1, argv: "/sbin/init" }],
      terminate: async () => {
        throw new Error("殺してはいけない");
      },
    });
    assert.deepEqual(await m.reapOrphans(), { killed: 0, failed: 2, errored: 0 });
    const st = await readState(dir);
    assert.equal(st.state, "failed");
    assert.equal(st.last_error, "前回の実行が終了しないまま server が落ちた");
  });
});

test("agents: reapOrphans は ps 不可なら error にする", async () => {
  await withFixture(0, async (f) => {
    const dir = await seedRunning(f, "caps", "c1", "sid-a");
    const m = mgr(f, async () => ok("x"), { listProcesses: async () => null });
    assert.deepEqual(await m.reapOrphans(), { killed: 0, failed: 0, errored: 1 });
    assert.equal((await readState(dir)).state, "error");
  });
});

test("agents: reapOrphans は一致したら terminate（注入）して failed", async () => {
  await withFixture(0, async (f) => {
    const dir = await seedRunning(f, "caps", "c1", "sid-a");
    const killed: number[] = [];
    const m = mgr(f, async () => ok("x"), {
      listProcesses: async () => [
        { pid: 999991, argv: "claude -p --resume sid-a -- hi" },
        { pid: 999992, argv: "claude -p --resume sid-z -- hi" },
      ],
      terminate: async (pid: number) => {
        killed.push(pid);
        return true;
      },
    });
    assert.deepEqual(await m.reapOrphans(), { killed: 1, failed: 0, errored: 0 });
    assert.deepEqual(killed, [999991]);
    const st = await readState(dir);
    assert.equal(st.state, "failed");
    assert.equal(st.last_error, "起動時に孤児プロセスを回収");
  });
});

test("agents: shutdown 後の invoke は拒否", async () => {
  await withFixture(0, async (f) => {
    const m = mgr(f, async () => ok("x"));
    await m.shutdown();
    await assert.rejects(m.invoke("cap", "c1", { prompt: "p" }), /server 終了中/);
  });
});

test("agents: state=error の agent は起動せず runner も呼ばない", async () => {
  await withFixture(0, async (f) => {
    const dir = join(f.ws, "caps", "c1");
    await writeState(dir, { session_id: "s", state: "error", last_started_at: null, last_finished_at: null, retries: 0 });
    const m = mgr(f, async () => ok("x"));
    await assert.rejects(m.invoke("cap", "c1", { prompt: "p" }), /c1 は state=error のため起動しない（state.json を確認）/);
    assert.equal(f.calls.length, 0);
    assert.equal((await readState(dir)).state, "error");
  });
});

test("agents: onSpawn 時点で終了中なら子を即 SIGKILL する", async () => {
  await withFixture(0, async (f) => {
    const killed: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const m = mgr(f, async (o) => {
      await gate;
      o.onSpawn?.({ kill: (sig: string) => killed.push(sig), once: () => {} } as never);
      return ng("kill された");
    });
    const p = m.invoke("cap", "c1", { prompt: "p" });
    await new Promise((r) => setTimeout(r, 20));
    const s = m.shutdown();
    release();
    const r = await p;
    await s;
    assert.deepEqual(killed, ["SIGKILL"]);
    assert.equal(r.ok, false);
    assert.equal(r.error, "server 終了により中断");
    assert.equal((await readState(join(f.ws, "caps", "c1"))).last_error, "server 終了により中断");
  });
});

test("agents: 再試行の直前に終了中なら runner を呼ばず中断", async () => {
  await withFixture(2, async (f) => {
    let m!: ReturnType<typeof mgr>;
    m = mgr(f, async () => {
      void m.shutdown();
      return ng("タイムアウト (1ms)", { timedOut: true });
    });
    const r = await m.invoke("cap", "c1", { prompt: "p" });
    assert.equal(r.ok, false);
    assert.equal(f.calls.length, 1);
  });
});

test("agents: reapOrphans は agent ごとの失敗を errored にして続行する", async () => {
  await withFixture(0, async (f) => {
    await seedRunning(f, "caps", "c1", "sid-a");
    const dir2 = await seedRunning(f, "caps", "c2", "sid-b");
    let n = 0;
    const m = mgr(f, async () => ok("x"), {
      listProcesses: async () => [
        { pid: 999991, argv: "claude -p --resume sid-a -- hi" },
        { pid: 999992, argv: "claude -p --resume sid-b -- hi" },
      ],
      terminate: async () => {
        if (++n === 1) throw new Error("kill 失敗");
        return true;
      },
    });
    const sum = await m.reapOrphans();
    assert.equal(sum.killed + sum.errored, 2);
    assert.equal((await readState(dir2)).state, sum.killed === 1 ? "failed" : "error");
  });
});
