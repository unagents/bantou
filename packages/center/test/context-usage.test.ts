import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import {
  contextWindowFor,
  createContextUsageTracker,
  makeUsage,
  parseAssistantUsage,
  projectDirName,
  readLastUsage,
  TAIL_START_BYTES,
  type UsageTarget,
} from "../src/context-usage.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "center-ctx-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const asst = (u: Partial<Record<string, number>>, extra: Record<string, unknown> = {}, model = "claude-opus-5-5"): string =>
  JSON.stringify({
    type: "assistant",
    timestamp: "2026-11-03T10:00:00.000Z",
    message: { model, usage: { input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0, ...u } },
    ...extra,
  });

test("parseAssistantUsage: 4 種の合計。assistant 以外・sidechain・synthetic・壊れた行は null", () => {
  const r = parseAssistantUsage(asst({ input_tokens: 2, cache_creation_input_tokens: 10, cache_read_input_tokens: 100, output_tokens: 5 }));
  assert.deepEqual(r, { tokens: 117, model: "claude-opus-5-5", at: "2026-11-03T10:00:00.000Z" });
  assert.equal(parseAssistantUsage(asst({ input_tokens: 1 }, { isSidechain: true })), null);
  assert.equal(parseAssistantUsage(asst({ input_tokens: 1 }, {}, "<synthetic>")), null);
  assert.equal(parseAssistantUsage(JSON.stringify({ type: "user", message: { usage: {} } })), null);
  assert.equal(parseAssistantUsage('{"type":"assistant","usage":'), null);
  assert.equal(parseAssistantUsage("not json"), null);
});

test("readLastUsage: 最後の assistant を返す。末尾が他の行でも、書きかけの行があっても拾う", async () => {
  const f = join(dir, "a.jsonl");
  await writeFile(f, [asst({ input_tokens: 1 }), asst({ input_tokens: 50 }), JSON.stringify({ type: "user" }), '{"type":"assis'].join("\n"));
  assert.equal((await readLastUsage(f))?.tokens, 50);
});

test("readLastUsage: 末尾の読み取りが足りなければ広げる。assistant が無ければ null", async () => {
  const f = join(dir, "b.jsonl");
  const big = JSON.stringify({ type: "user", pad: "x".repeat(TAIL_START_BYTES * 2) });
  await writeFile(f, [asst({ output_tokens: 7 }), big, big].join("\n") + "\n");
  assert.equal((await readLastUsage(f))?.tokens, 7);
  const g = join(dir, "c.jsonl");
  await writeFile(g, JSON.stringify({ type: "user" }) + "\n");
  assert.equal(await readLastUsage(g), null);
});

test("contextWindowFor: [1m] だけ 1M。素の名前・未指定は null", () => {
  assert.equal(contextWindowFor("opus[1m]"), 1_000_000);
  assert.equal(contextWindowFor(undefined, "claude-opus-5-5[1M]"), 1_000_000);
  assert.equal(contextWindowFor("claude-opus-5-5"), null);
  assert.equal(contextWindowFor(), null);
});

test("makeUsage: percent は小数 1 桁。窓が null なら null", () => {
  assert.deepEqual(makeUsage(84_000, 1_000_000, "t"), { usedTokens: 84_000, windowTokens: 1_000_000, percent: 8.4, updatedAt: "t" });
  assert.deepEqual(makeUsage(10, null, "t"), { usedTokens: 10, windowTokens: null, percent: null, updatedAt: "t" });
});

test("projectDirName: 英数字以外は -", () => {
  assert.equal(projectDirName("/home/vagrant/work/bantou-server-ws/w_1.x"), "-home-vagrant-work-bantou-server-ws-w-1-x");
});

test("tracker: 今回の起動以降の最新 transcript を読み、変化した時だけ onChange。同じなら再読しない", async () => {
  const cwd = "/ws/pm1";
  const pdir = join(dir, "projects", projectDirName(cwd));
  await mkdir(pdir, { recursive: true });
  const old = join(pdir, "old.jsonl");
  await writeFile(old, asst({ input_tokens: 999_999 }) + "\n");
  await utimes(old, new Date("2020-01-01"), new Date("2020-01-01"));
  const cur = join(pdir, "cur.jsonl");
  await writeFile(cur, asst({ input_tokens: 1, cache_read_input_tokens: 83_999 }) + "\n");
  const target: UsageTarget = { name: "pm1", path: cwd, startedAt: new Date(Date.now() - 60_000).toISOString(), running: true };
  const changes: string[] = [];
  const tr = createContextUsageTracker({ targets: () => [target], onChange: (n) => changes.push(n), configDir: dir, model: "opus[1m]" });
  assert.equal(tr.get("pm1"), null);
  await tr.poll();
  assert.deepEqual(changes, ["pm1"]);
  assert.deepEqual(tr.get("pm1"), { usedTokens: 84_000, windowTokens: 1_000_000, percent: 8.4, updatedAt: "2026-11-03T10:00:00.000Z" });
  await tr.poll();
  assert.equal(changes.length, 1);
  await appendFile(cur, asst({ input_tokens: 1, cache_read_input_tokens: 99_999 }, { timestamp: "2026-11-03T11:00:00.000Z" }) + "\n");
  await tr.poll();
  assert.deepEqual(changes, ["pm1", "pm1"]);
  assert.equal(tr.get("pm1")?.usedTokens, 100_000);
  // 停止中は更新しないが値は残る。起動し直すと捨てる
  target.running = false;
  await tr.poll();
  assert.equal(tr.get("pm1")?.usedTokens, 100_000);
  target.running = true;
  target.startedAt = new Date(Date.now() + 60_000).toISOString();
  await tr.poll();
  assert.equal(tr.get("pm1"), null);
  assert.equal(changes.length, 3);
});

test("tracker: transcript が無い時は null、窓が不明な時は percent null", async () => {
  const cwd = "/ws/none";
  const t: UsageTarget = { name: "n", path: cwd, startedAt: new Date(Date.now() - 1000).toISOString(), running: true };
  const tr = createContextUsageTracker({ targets: () => [t], onChange: () => {}, configDir: dir });
  await tr.poll();
  assert.equal(tr.get("n"), null);
  const pdir = join(dir, "projects", projectDirName(cwd));
  await mkdir(pdir, { recursive: true });
  await writeFile(join(pdir, "s.jsonl"), asst({ input_tokens: 5 }) + "\n");
  await tr.poll();
  assert.deepEqual(tr.get("n"), { usedTokens: 5, windowTokens: null, percent: null, updatedAt: "2026-11-03T10:00:00.000Z" });
});
