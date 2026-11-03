import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, readFile, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import type { AgentActivity } from "@agent-hand/bantou-protocol";
import { STOP_MSG, createAgentManager } from "../../../../server/utils/bantou/agents";
import { cleanWorkerDir, createWorkerCleaner } from "../../../../server/utils/bantou/cleanup";
import { DEFAULT_SESSION, type Config } from "../../../../server/utils/bantou/config";
import { cleanedFile } from "../../../../server/utils/bantou/paths";
import { readState, writeState } from "../../../../server/utils/bantou/state";
import { createWorkerHub, writeOwner } from "../../../../server/utils/bantou/workers";

const T0 = Date.parse("2026-11-04T00:00:00.000Z");
const iso = (t: number): string => new Date(t).toISOString();
const KEEP = 1000;

const worker = (id: string, capId: string, state: AgentActivity["state"], finishedAt: number | null, error?: string): AgentActivity => ({
  kind: "worker", id, cap_id: capId, state, task: "t", last_activity: null, last_output_at: null, silent_ms: 0,
  started_at: iso(T0 - 5000), finished_at: finishedAt === null ? null : iso(finishedAt), ...(error ? { error } : {}),
});
const cap = (id: string, state: AgentActivity["state"], finishedAt: number | null): AgentActivity => ({
  kind: "cap", id, cap_id: id, state, task: "t", last_activity: null, last_output_at: null, silent_ms: 0,
  started_at: iso(T0 - 5000), finished_at: finishedAt === null ? null : iso(finishedAt),
});

interface Fx {
  ws: string;
  acts: AgentActivity[];
  t: { now: number };
  forgot: string[];
  active: Set<string>;
  logs: string[];
  cleaner: ReturnType<typeof createWorkerCleaner>;
}

async function populate(ws: string, id: string): Promise<string> {
  const dir = join(ws, "workers", id);
  await mkdir(join(dir, "logs"), { recursive: true });
  await mkdir(join(dir, "node_modules", "x"), { recursive: true });
  await mkdir(join(dir, ".git"), { recursive: true });
  await writeFile(join(dir, "logs", "s.jsonl"), "log\n");
  await writeFile(join(dir, "state.json"), "{}\n");
  await writeFile(join(dir, "src.ts"), "x");
  await writeFile(join(dir, "node_modules", "x", "i.js"), "x");
  await writeOwner(ws, id, "c1");
  return dir;
}

async function withFx(keepMs: number, fn: (f: Fx) => Promise<void>): Promise<void> {
  const base = await mkdtemp(join(tmpdir(), "bantou-cleanup-test-"));
  try {
    const ws = join(base, "ws");
    await mkdir(join(ws, "caps", "c1"), { recursive: true });
    const f = { ws, acts: [] as AgentActivity[], t: { now: T0 }, forgot: [] as string[], active: new Set<string>(), logs: [] as string[] } as Fx;
    f.cleaner = createWorkerCleaner({
      workspace: ws,
      keepMs,
      snapshot: () => f.acts,
      isActive: (id) => f.active.has(id),
      forget: (id) => f.forgot.push(id),
      log: (m) => f.logs.push(m),
      now: () => f.t.now,
      intervalMs: 3_600_000,
    });
    try {
      await fn(f);
    } finally {
      await f.cleaner.close();
    }
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}

const names = async (dir: string): Promise<string[]> => (await readdir(dir)).sort();

test("cleanWorkerDir: logs/ と state.json 以外を消し、logs の中身は残して cleaned.json を足す", async () => {
  await withFx(KEEP, async (f) => {
    const dir = await populate(f.ws, "w1");
    const n = await cleanWorkerDir(dir);
    assert.equal(n, 3); // .git, node_modules, src.ts
    assert.deepEqual(await names(dir), ["logs", "state.json"]);
    assert.deepEqual(await names(join(dir, "logs")), ["cleaned.json", "owner.json", "s.jsonl"]);
    assert.equal(await readFile(join(dir, "logs", "s.jsonl"), "utf8"), "log\n");
    assert.equal(await readFile(join(dir, "state.json"), "utf8"), "{}\n");
    assert.equal((await stat(cleanedFile(dir))).isFile(), true);
    assert.equal(await cleanWorkerDir(join(f.ws, "workers", "none")), 0); // 無い dir は何もしない
  });
});

test("sweep: done の worker は cap が idle で keepMs 経ったら掃除し、activity から外してログに出す", async () => {
  await withFx(KEEP, async (f) => {
    const dir = await populate(f.ws, "w1");
    f.acts = [cap("c1", "idle", T0), worker("w1", "c1", "done", T0 - 10)];
    f.t.now = T0 + KEEP - 1;
    assert.deepEqual(await f.cleaner.sweep(), []);
    assert.deepEqual(await names(dir), [".git", "logs", "node_modules", "src.ts", "state.json"]);
    f.t.now = T0 + KEEP;
    assert.deepEqual(await f.cleaner.sweep(), ["w1"]);
    assert.deepEqual(await names(dir), ["logs", "state.json"]);
    assert.deepEqual(f.forgot, ["w1"]);
    assert.ok(f.logs.some((l) => l.includes("worker 掃除") && l.includes("worker_id=w1")));
  });
});

test("sweep: worker_stop で止めた worker（failed + STOP_MSG）も同じ。他の failed / idle は掃除しない", async () => {
  await withFx(KEEP, async (f) => {
    const d1 = await populate(f.ws, "w1");
    const d2 = await populate(f.ws, "w2");
    const d3 = await populate(f.ws, "w3");
    f.acts = [
      cap("c1", "idle", T0 - 5000),
      worker("w1", "c1", "failed", T0 - 5000, STOP_MSG),
      worker("w2", "c1", "failed", T0 - 5000, "boom"),
      worker("w3", "c1", "idle", T0 - 5000),
    ];
    f.t.now = T0 + KEEP;
    assert.deepEqual(await f.cleaner.sweep(), ["w1"]);
    assert.deepEqual(await names(d1), ["logs", "state.json"]);
    assert.equal((await names(d2)).length, 5);
    assert.equal((await names(d3)).length, 5);
  });
});

test("sweep: cap が running / stalled の間は掃除しない。cap の turn 終了から数え直す", async () => {
  await withFx(KEEP, async (f) => {
    const dir = await populate(f.ws, "w1");
    f.acts = [cap("c1", "running", null), worker("w1", "c1", "done", T0 - 10_000)];
    f.t.now = T0 + 10 * KEEP;
    assert.deepEqual(await f.cleaner.sweep(), []);
    f.acts = [cap("c1", "stalled", null), worker("w1", "c1", "done", T0 - 10_000)];
    assert.deepEqual(await f.cleaner.sweep(), []);
    // cap の turn が終わった時刻から keepMs
    f.acts = [cap("c1", "idle", f.t.now), worker("w1", "c1", "done", T0 - 10_000)];
    f.t.now += KEEP - 1;
    assert.deepEqual(await f.cleaner.sweep(), []);
    f.t.now += 1;
    assert.deepEqual(await f.cleaner.sweep(), ["w1"]);
    assert.deepEqual(await names(dir), ["logs", "state.json"]);
  });
});

test("sweep: 再開の指示（invoke 中）がある worker は掃除しない。running の worker も掃除しない", async () => {
  await withFx(KEEP, async (f) => {
    await populate(f.ws, "w1");
    await populate(f.ws, "w2");
    f.acts = [cap("c1", "idle", T0 - 9000), worker("w1", "c1", "done", T0 - 9000), worker("w2", "c1", "running", null)];
    f.active.add("w1");
    f.t.now = T0 + 10 * KEEP;
    assert.deepEqual(await f.cleaner.sweep(), []);
    f.active.delete("w1");
    assert.deepEqual(await f.cleaner.sweep(), ["w1"]);
  });
});

test("無効化: keepMs 0 は何も消さず、タイマーも張らない", async () => {
  await withFx(0, async (f) => {
    const dir = await populate(f.ws, "w1");
    f.acts = [cap("c1", "idle", T0 - 9999999), worker("w1", "c1", "done", T0 - 9999999)];
    f.t.now = T0 + 99999999;
    assert.deepEqual(await f.cleaner.sweep(), []);
    assert.equal((await names(dir)).length, 5);
    assert.deepEqual(f.forgot, []);
  });
});

test("再開で中断: begin（worker_start の入口）で待ち時間を数え直す", async () => {
  await withFx(KEEP, async (f) => {
    const dir = await populate(f.ws, "w1");
    f.acts = [cap("c1", "idle", T0 - 9000), worker("w1", "c1", "done", T0 - 9000)];
    f.t.now = T0;
    await f.cleaner.begin("w1");
    f.t.now = T0 + KEEP - 1;
    assert.deepEqual(await f.cleaner.sweep(), []);
    assert.equal((await names(dir)).length, 5);
  });
});

test("再開で中断: 他の持ち主の worker・持ち主不明の dir は消さない", async () => {
  await withFx(KEEP, async (f) => {
    const dir = await populate(f.ws, "w1");
    f.acts = [cap("c9", "idle", T0 - 9000), worker("w1", "c9", "done", T0 - 9000)];
    f.t.now = T0 + 10 * KEEP;
    await f.cleaner.sweep();
    assert.equal((await names(dir)).length, 5);
    assert.deepEqual(f.forgot, []);
  });
});

test("再開で中断: 掃除の判定後・削除前に begin が来たら削除を見送り、activity も残す", async () => {
  await withFx(KEEP, async (f) => {
    const dir = await populate(f.ws, "w1");
    f.acts = [cap("c1", "idle", T0 - 9000), worker("w1", "c1", "done", T0 - 9000)];
    f.t.now = T0 + 10 * KEEP;
    const sweeping = f.cleaner.sweep(); // 判定済み、削除はまだ（owner 読み込み待ち）
    await f.cleaner.begin("w1");
    assert.deepEqual(await sweeping, []);
    assert.equal((await names(dir)).length, 5);
    assert.deepEqual(f.forgot, []);
  });
});

// -- 再開（clone し直し）: 実 git を使う ------------------------------------

function mkRepo(root: string): string {
  const repo = join(root, "origin");
  const run = (...a: string[]): void => void execFileSync("git", ["-C", repo, ...a], { stdio: "ignore" });
  execFileSync("git", ["init", "-q", "-b", "main", repo], { stdio: "ignore" });
  run("config", "user.email", "t@example.com");
  run("config", "user.name", "t");
  return repo;
}

async function withGit(fn: (o: { ws: string; repo: string; config: Config; cwds: string[]; prompts: string[]; hub: ReturnType<typeof createWorkerHub> }) => Promise<void>): Promise<void> {
  const base = await mkdtemp(join(tmpdir(), "bantou-cleanup-git-"));
  try {
    const repo = mkRepo(base);
    await writeFile(join(repo, "a.txt"), "A\n");
    execFileSync("git", ["-C", repo, "add", "."], { stdio: "ignore" });
    execFileSync("git", ["-C", repo, "commit", "-q", "-m", "init"], { stdio: "ignore" });
    const ws = join(base, "ws");
    await mkdir(join(ws, "caps", "c1"), { recursive: true });
    await mkdir(join(ws, "workers"), { recursive: true });
    const config: Config = {
      workspace: ws,
      broker: { port: 0, bind: "127.0.0.1", discovery: "off", token: "" },
      mcp: { port: 0, bind: "127.0.0.1" },
      session: { ...structuredClone(DEFAULT_SESSION) },
      update: { spec: "bantou@{version}" },
    };
    const cwds: string[] = [];
    const prompts: string[] = [];
    const manager = createAgentManager({
      config,
      log: () => {},
      runner: { run: async (o) => (cwds.push(o.cwd), prompts.push(o.prompt), { ok: true, sessionId: "x", resultText: "", durationMs: 1 }) },
      runExtras: async (kind, id, input) => {
        if (kind === "worker") await writeOwner(ws, id, input.capId as string);
        return {};
      },
    });
    const hub = createWorkerHub({ workspace: ws, manager, activity: { snapshot: () => [] }, log: () => {} });
    await fn({ ws, repo, config, cwds, prompts, hub });
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}

const settleRuns = (): Promise<void> => new Promise((r) => setTimeout(r, 400));

test("再開: 掃除後の同じ worker_id の worker_start は clone し直す（repo 省略でも前回の clone 元）。logs と state は残る", async () => {
  await withGit(async ({ ws, repo, hub }) => {
    await hub.start("c1", { worker_id: "w1", prompt: "p", repo });
    await settleRuns();
    const dir = join(ws, "workers", "w1");
    assert.equal(await readFile(join(dir, "a.txt"), "utf8"), "A\n");
    const before = await readState(dir);
    assert.equal(before.state, "idle");

    await cleanWorkerDir(dir);
    assert.deepEqual(await names(dir), ["logs", "state.json"]);

    await hub.start("c1", { worker_id: "w1", prompt: "again" });
    await settleRuns();
    assert.equal(await readFile(join(dir, "a.txt"), "utf8"), "A\n");
    assert.equal((await stat(join(dir, ".git"))).isDirectory(), true);
    assert.equal((await stat(join(dir, "logs", "owner.json"))).isFile(), true);
    await assert.rejects(stat(cleanedFile(dir)), /ENOENT/); // 印は消える
    assert.equal((await readState(dir)).session_id, before.session_id);
    // 以降の掃除し直しも同じ
    await cleanWorkerDir(dir);
    await hub.start("c1", { worker_id: "w1", prompt: "third", repo });
    await settleRuns();
    assert.equal(await readFile(join(dir, "a.txt"), "utf8"), "A\n");
    assert.equal((await names(dir)).filter((n) => n.includes("clone-")).length, 0);
  });
});

test("再開: 掃除していない（.git が残る）worker は従来どおり fetch で進む。state.json を手で消した dir は触らない", async () => {
  await withGit(async ({ ws, repo, hub }) => {
    await hub.start("c1", { worker_id: "w2", prompt: "p", repo });
    await settleRuns();
    await hub.start("c1", { worker_id: "w2", prompt: "q", repo });
    await settleRuns();
    assert.equal((await readState(join(ws, "workers", "w2"))).state, "idle");
    // 印の無い non-git dir は従来どおり失敗
    await mkdir(join(ws, "workers", "w3", "logs"), { recursive: true });
    await writeState(join(ws, "workers", "w3"), { session_id: null, state: "idle", last_started_at: null, last_finished_at: null, retries: 0 });
    await writeOwner(ws, "w3", "c1");
    await hub.start("c1", { worker_id: "w3", prompt: "p", repo });
    await settleRuns();
    assert.equal((await readState(join(ws, "workers", "w3"))).state, "failed");
  });
});

test("再開: 掃除が途中で止まった dir（印あり・.git 無し・残骸あり）でも clone し直せる。記録が無ければ空 dir で起動", async () => {
  await withGit(async ({ ws, repo, hub }) => {
    await hub.start("c1", { worker_id: "w4", prompt: "p", repo });
    await settleRuns();
    const dir = join(ws, "workers", "w4");
    await cleanWorkerDir(dir);
    await mkdir(join(dir, "node_modules"), { recursive: true }); // 残骸
    await writeFile(join(dir, "a.txt"), "stale"); // 同名の残骸
    await hub.start("c1", { worker_id: "w4", prompt: "again" });
    await settleRuns();
    assert.equal(await readFile(join(dir, "a.txt"), "utf8"), "A\n");
    assert.equal((await names(dir)).includes("node_modules"), false);

    // clone 元の記録が無い掃除済み dir（repo 無しで作った worker 相当）は、空のまま起動する
    await cleanWorkerDir(dir);
    await rm(join(dir, "logs", "repo.json"));
    await hub.start("c1", { worker_id: "w4", prompt: "norepo" });
    await settleRuns();
    assert.equal((await readState(dir)).state, "idle");
    assert.deepEqual(await names(dir), ["logs", "state.json"]);
  });
});

test("worker_start: 別の cap の worker_id では掃除の待ち時間を数え直さない（begin を呼ばない）", async () => {
  const base = await mkdtemp(join(tmpdir(), "bantou-cleanup-owner-"));
  try {
    const ws = join(base, "ws");
    await mkdir(join(ws, "caps", "c1"), { recursive: true });
    await mkdir(join(ws, "caps", "c2"), { recursive: true });
    await writeOwner(ws, "w9", "c1");
    const begun: string[] = [];
    const hub = createWorkerHub({
      workspace: ws,
      manager: { invoke: async () => ({ session_id: "s", ok: true, result_text: "" }), stop: async () => ({ stopped: true }) },
      activity: { snapshot: () => [] },
      log: () => {},
      cleaner: { begin: async (id) => void begun.push(id) },
    });
    await assert.rejects(hub.start("c2", { worker_id: "w9", prompt: "p" }), /別の cap の worker/);
    assert.deepEqual(begun, []);
    await hub.start("c1", { worker_id: "w9", prompt: "p" });
    assert.deepEqual(begun, ["w9"]);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("再開: repo 無しで作った worker（自分で clone する運用）は掃除後も repo 無しの worker_start が成功し、空 dir で起動する", async () => {
  await withGit(async ({ ws, prompts, hub }) => {
    await hub.start("c1", { worker_id: "w5", prompt: "first" }); // repo 引数なし: repo.json は書かれない
    await settleRuns();
    const dir = join(ws, "workers", "w5");
    await assert.rejects(stat(join(dir, "logs", "repo.json")), /ENOENT/);
    await mkdir(join(dir, "own-clone", ".git"), { recursive: true }); // worker が dir 内で自分で clone したもの
    await mkdir(join(dir, ".git"), { recursive: true });
    await writeFile(join(dir, "own-clone", "x.ts"), "x");
    const sid = (await readState(dir)).session_id;

    await cleanWorkerDir(dir);
    assert.deepEqual(await names(dir), ["logs", "state.json"]);
    await hub.start("c1", { worker_id: "w5", prompt: "again" });
    await settleRuns();
    assert.equal((await readState(dir)).state, "idle");
    assert.deepEqual(await names(dir), ["logs", "state.json"]); // 空のまま
    assert.equal((await readState(dir)).session_id, sid);
    assert.equal(prompts.at(-1)?.startsWith("again"), true);
    assert.ok(prompts.at(-1)?.includes("掃除されて空"));
    assert.equal(prompts[0], "first"); // 掃除前の prompt には足さない
  });
});

test("掃除の失敗は同じ理由なら 1 回だけログに出す。再開（begin）か成功で出し直す", async () => {
  await withFx(KEEP, async (f) => {
    const dir = await populate(f.ws, "w1");
    await rename(join(dir, "logs"), join(f.ws, "logs-elsewhere"));
    await symlink(join(f.ws, "logs-elsewhere"), join(dir, "logs")); // logs が symlink（owner.json は読める）→ 掃除は失敗
    f.acts = [cap("c1", "idle", T0 - 9000), worker("w1", "c1", "done", T0 - 9000)];
    f.t.now = T0 + 10 * KEEP;
    await f.cleaner.sweep();
    await f.cleaner.sweep();
    await f.cleaner.sweep();
    assert.equal(f.logs.filter((l) => l.includes("エラー: worker 掃除")).length, 1);
    await f.cleaner.begin("w1"); // 再開で抑制を解く → 次の失敗は出し直す
    f.t.now += 10 * KEEP;
    await f.cleaner.sweep();
    assert.equal(f.logs.filter((l) => l.includes("エラー: worker 掃除")).length, 2);
  });
});

test("持ち主記録（logs/owner.json）が無い worker は掃除せず、worker ごとに 1 回だけログに出す", async () => {
  await withFx(KEEP, async (f) => {
    const dir = await populate(f.ws, "w1");
    await rm(join(dir, "logs", "owner.json"));
    f.acts = [cap("c1", "idle", T0 - 9000), worker("w1", "c1", "done", T0 - 9000)];
    f.t.now = T0 + 10 * KEEP;
    for (let i = 0; i < 3; i++) assert.deepEqual(await f.cleaner.sweep(), []);
    assert.equal((await names(dir)).length, 5);
    assert.deepEqual(f.logs.filter((l) => l.includes("持ち主記録が無いので掃除しない")), ["持ち主記録が無いので掃除しない: w1"]);
    assert.deepEqual(f.forgot, []);
  });
});

test("cleanWorkerDir: logs が symlink なら何も書かず消さず、投げる（dir の外へ書かせない）", async () => {
  await withFx(KEEP, async (f) => {
    const outside = join(f.ws, "outside");
    await mkdir(outside, { recursive: true });
    const dir = join(f.ws, "workers", "w1");
    await mkdir(join(dir, "node_modules"), { recursive: true });
    await symlink(outside, join(dir, "logs"));
    await assert.rejects(cleanWorkerDir(dir), /logs が通常の directory でない/);
    assert.deepEqual(await readdir(outside), []);
    assert.equal((await names(dir)).includes("node_modules"), true);
  });
});

test("cleanWorkerDir: 印 cleaned.json が symlink でも、先を書き換えず印そのものを置き換える", async () => {
  await withFx(KEEP, async (f) => {
    const dir = await populate(f.ws, "w1");
    const target = join(f.ws, "target.txt");
    await writeFile(target, "keep");
    await symlink(target, join(dir, "logs", "cleaned.json"));
    await cleanWorkerDir(dir);
    assert.equal(await readFile(target, "utf8"), "keep");
    assert.match(await readFile(join(dir, "logs", "cleaned.json"), "utf8"), /cleaned_at/);
  });
});
