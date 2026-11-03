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

// ---- statusLine 方式 ----
import { parseStatusLine } from "../src/context-usage.js";

const sl = (cw: Record<string, unknown>, model = "claude-opus-5-5"): unknown => ({ model: { id: model, display_name: "Opus" }, context_window: cw });
const SL_USED = { total_input_tokens: 58789, total_output_tokens: 178, context_window_size: 1_000_000, used_percentage: 6, remaining_percentage: 94 };

test("parseStatusLine: 窓は context_window_size、使用量は total_input_tokens（output を含まない）、percent は小数 1 桁で出し直す", () => {
  assert.deepEqual(parseStatusLine(sl(SL_USED)), { windowTokens: 1_000_000, usedTokens: 58789, percent: 5.9, model: "claude-opus-5-5" });
  // 窓が無ければ used_percentage をそのまま
  assert.deepEqual(parseStatusLine(sl({ total_input_tokens: 10, used_percentage: 3 })), { windowTokens: null, usedTokens: 10, percent: 3, model: "claude-opus-5-5" });
  // used_percentage が null（API 応答前・/compact 直後）は使用量なし、窓だけ
  assert.deepEqual(parseStatusLine(sl({ total_input_tokens: 0, context_window_size: 1_000_000, used_percentage: null, current_usage: null })), {
    windowTokens: 1_000_000,
    usedTokens: null,
    percent: null,
    model: "claude-opus-5-5",
  });
  for (const bad of [null, "x", 1, {}, { context_window: null }, { context_window: {} }, { context_window: { context_window_size: 0, used_percentage: null } }]) {
    assert.equal(parseStatusLine(bad), null);
  }
});

test("tracker.applyStatusLine: 値が変わった時だけ onChange。statusLine が transcript に優先し、無い間は transcript", async () => {
  const cwd = "/work/sl1";
  const pdir = join(dir, "projects", projectDirName(cwd));
  await mkdir(pdir, { recursive: true });
  await writeFile(join(pdir, "s.jsonl"), asst({ input_tokens: 250_000 }) + "\n");
  const t: UsageTarget = { name: "sl1", path: cwd, startedAt: new Date(Date.now() - 1000).toISOString(), running: true };
  const changes: string[] = [];
  const tr = createContextUsageTracker({ targets: () => [t], onChange: (n) => changes.push(n), configDir: dir });
  await tr.poll();
  // statusLine が無い間は transcript（窓は不明）
  assert.equal(tr.get("sl1")?.windowTokens, null);
  assert.equal(tr.get("sl1")?.usedTokens, 250_000);
  changes.length = 0;
  // used_percentage が null の間: 窓だけ補い、tokens は transcript のまま
  assert.equal(tr.applyStatusLine("sl1", sl({ total_input_tokens: 0, context_window_size: 1_000_000, used_percentage: null }), t.startedAt), true);
  assert.deepEqual(
    { u: tr.get("sl1")?.usedTokens, w: tr.get("sl1")?.windowTokens, p: tr.get("sl1")?.percent },
    { u: 250_000, w: 1_000_000, p: 25 },
  );
  assert.deepEqual(changes, ["sl1"]);
  // 値が入ったら statusLine が正本（model も付く）
  tr.applyStatusLine("sl1", sl(SL_USED), t.startedAt);
  const u = tr.get("sl1")!;
  assert.deepEqual({ ...u, updatedAt: "-" }, { usedTokens: 58789, windowTokens: 1_000_000, percent: 5.9, updatedAt: "-", model: "claude-opus-5-5" });
  assert.equal(changes.length, 2);
  // 同じ値は通知しない
  tr.applyStatusLine("sl1", sl(SL_USED), t.startedAt);
  assert.equal(changes.length, 2);
  // 読めない JSON は反映せず false
  assert.equal(tr.applyStatusLine("sl1", { nope: 1 }, t.startedAt), false);
  assert.equal(tr.get("sl1")?.usedTokens, 58789);
  // poll しても statusLine のまま
  await tr.poll();
  assert.equal(tr.get("sl1")?.usedTokens, 58789);
  // 起動し直したら statusLine の値は捨て、transcript に戻る
  t.startedAt = new Date(Date.now() - 500).toISOString();
  await tr.poll();
  assert.equal(tr.get("sl1")?.model, undefined);
  assert.equal(tr.get("sl1")?.usedTokens, 250_000);
});
