import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createSessionMcpServer } from "../src/server.js";
import type { RemoteManager, RemoteView, StoredWorkerReport } from "../src/remotes.js";
import { buildTaskStatus, limitRemoteList, REMOTE_LIST_TOTAL_MAX, TASK_STATUS_MAX_CHARS, TASK_STATUS_MAX_LINES } from "../src/task-status.js";

const NOW = Date.parse("2026-01-01T01:00:00Z");
const iso = (minAgo: number): string => new Date(NOW - minAgo * 60_000).toISOString();

const report = (task_id: string, kind: StoredWorkerReport["kind"], minAgo: number, text = "x", extra: Partial<StoredWorkerReport> = {}): StoredWorkerReport =>
  ({ bantou: 1, type: "worker_report", cap_id: "c", task_id, worker_id: "w", kind, text, at: iso(minAgo), ...extra }) as StoredWorkerReport;

const view = (session: string, tasks: { id: string; minAgo: number }[], reports: StoredWorkerReport[] = [], extra: Partial<RemoteView> = {}): RemoteView =>
  ({
    remote_id: `c-1-${session}`, session, server: "s", serverName: "n", state: "running", createdAt: iso(100), owners: [session],
    pending: tasks.map((t) => ({ at: iso(t.minAgo), owner: session, prompt: "SECRET-PROMPT", task_id: t.id, delivery: "observed" as const })),
    reachability: { reachable: true, last_ok_at: iso(0), failures: 0 }, cap_state: "running", worker_reports: reports, server_label: "host-a", ...extra,
  }) as RemoteView;

test("task_status: task ごとに 1 行。状態・経過・最後の報告・判断が要る件数。本文は入らない", () => {
  const v = view("alpha", [{ id: "t-1", minAgo: 12 }, { id: "t-2", minAgo: 3 }], [
    report("t-1", "progress", 8, "SECRET-BODY"),
    report("t-1", "ask", 5, "q1"),
    report("t-1", "approve", 4, "q2", { replied_at: iso(2) }),
  ]);
  const r = buildTaskStatus([v], "alpha", NOW);
  assert.equal(r.tasks.length, 2);
  assert.equal(r.tasks[0]!.line, "t-1 | host-a | 返答待ち | 経過 12 分 | 最後の報告 approve 4 分前 | 判断が要る 1");
  assert.equal(r.tasks[1]!.line, "t-2 | host-a | 実行中 | 経過 3 分 | 最後の報告 なし | 判断が要る 0");
  assert.ok(!JSON.stringify(r).includes("SECRET"));
  assert.equal(r.truncated, false);
});

test("task_status: 他の session の task は見えない（owner と pending の owner の両方で絞る）", () => {
  const mine = view("alpha", [{ id: "t-mine", minAgo: 1 }]);
  const other = view("beta", [{ id: "t-other", minAgo: 1 }]);
  const mixed = view("alpha", [{ id: "t-x", minAgo: 1 }]);
  mixed.pending.push({ at: iso(1), owner: "beta", prompt: "p", task_id: "t-beta-in-alpha-cap" });
  const r = buildTaskStatus([mine, other, mixed], "alpha", NOW);
  assert.deepEqual(r.tasks.map((t) => t.task_id).sort(), ["t-mine", "t-x"]);
});

test("task_status: 行数・文字数の上限で切れて truncated と omitted が付く", () => {
  const many = view("alpha", Array.from({ length: TASK_STATUS_MAX_LINES + 15 }, (_, i) => ({ id: `t-${i}`, minAgo: 100 - i })));
  const r = buildTaskStatus([many], "alpha", NOW);
  assert.equal(r.tasks.length, TASK_STATUS_MAX_LINES);
  assert.equal(r.truncated, true);
  assert.equal(r.omitted, 15);
  const longLabel = view("alpha", Array.from({ length: 40 }, (_, i) => ({ id: `t-${i}-${"y".repeat(100)}`, minAgo: 100 - i })), [], { server_label: "h".repeat(150) });
  const r2 = buildTaskStatus([longLabel], "alpha", NOW);
  assert.ok(r2.tasks.every((t) => t.line.length <= 200));
  assert.ok(r2.tasks.reduce((n, t) => n + t.line.length, 0) <= TASK_STATUS_MAX_CHARS);
  assert.ok(r2.truncated && r2.omitted > 0);
});

test("task_status: 不通・lost・失敗の状態", () => {
  assert.match(buildTaskStatus([view("a", [{ id: "t", minAgo: 1 }], [], { reachability: { reachable: false, last_ok_at: null, failures: 3 } })], "a", NOW).tasks[0]!.line, /\| 不通 \|/);
  assert.match(buildTaskStatus([view("a", [{ id: "t", minAgo: 1 }], [], { cap_state: "lost" })], "a", NOW).tasks[0]!.line, /\| lost \|/);
  assert.match(buildTaskStatus([view("a", [{ id: "t", minAgo: 1 }], [], { state: "failed" })], "a", NOW).tasks[0]!.line, /\| 失敗 \|/);
});

test("limitRemoteList: report の本文 300 文字・result 2000 文字で切り、印が付く", () => {
  const v = view("a", [], [report("t", "done", 1, "z".repeat(5000))], { result: "r".repeat(9000) });
  const [o] = limitRemoteList([v]) as (RemoteView & { truncated?: { report_texts_cut: number; result_cut: boolean; note: string } })[];
  assert.ok(o!.worker_reports[0]!.text.length < 400);
  assert.ok(o!.result!.length < 2100);
  assert.equal(o!.truncated?.report_texts_cut, 1);
  assert.equal(o!.truncated?.result_cut, true);
  assert.match(o!.truncated!.note, /上限/);
});

test("limitRemoteList: 大量の入力でも 1 回 20000 文字以内。古い report から落とし、件数が印に出る", () => {
  const reports = Array.from({ length: 20 }, (_, i) => report("t", "progress", 30 - i, `${i}:` + "q".repeat(20000)));
  const views = ["a", "b", "c", "d"].map((s) => view(s, [], reports, { result: "r".repeat(8000) }));
  const out = limitRemoteList(views);
  assert.ok(JSON.stringify(out, null, 2).length <= REMOTE_LIST_TOTAL_MAX, `size ${JSON.stringify(out, null, 2).length}`);
  const dropped = out.reduce((n, v) => n + ((v as RemoteView & { truncated?: { reports_dropped: number } }).truncated?.reports_dropped ?? 0), 0);
  assert.ok(dropped > 0);
  for (const v of out as (RemoteView & { truncated?: { reports_dropped: number } })[]) if (v.truncated && v.worker_reports.length > 0) assert.ok(v.worker_reports[0]!.text.startsWith(`${20 - v.worker_reports.length}:`) || v.truncated.reports_dropped > 0);
  // 残るのは新しい report
  const kept = (out[0] as RemoteView).worker_reports;
  if (kept.length > 0) assert.ok(kept[kept.length - 1]!.text.startsWith("19:"));
});

test("limitRemoteList: 小さい入力は変わらない（印なし）", () => {
  const v = view("a", [], [report("t", "done", 1, "ok")], { result: "short" });
  assert.deepEqual(limitRemoteList([v]), [v]);
});

async function sessionClient(remotes: Partial<RemoteManager>, owner: string) {
  const s = createSessionMcpServer({ remotes: remotes as RemoteManager, owner });
  const [c, st] = InMemoryTransport.createLinkedPair();
  const cl = new Client({ name: "ts", version: "0" });
  await Promise.all([s.connect(st), cl.connect(c)]);
  return cl;
}
const body = (r: unknown): unknown => JSON.parse((r as { content: { text: string }[] }).content[0]!.text);

test("session の MCP: task_status が owner の task だけ返し、remote_list は上限つき。tool の schema は pattern を持たない", async () => {
  const calls: unknown[] = [];
  const all = [view("alpha", [{ id: "t-mine", minAgo: 1 }], [report("t-mine", "done", 1, "z".repeat(5000))]), view("beta", [{ id: "t-other", minAgo: 1 }])];
  const cl = await sessionClient({ list: (f: unknown) => (calls.push(f), all.filter((v) => v.session === (f as { owner: string }).owner)) } as Partial<RemoteManager>, "alpha");
  const names = (await cl.listTools()).tools.map((t) => t.name);
  assert.ok(names.includes("task_status"));
  const ts = body(await cl.callTool({ name: "task_status", arguments: {} })) as { tasks: { task_id: string }[] };
  assert.deepEqual(ts.tasks.map((t) => t.task_id), ["t-mine"]);
  const rl = body(await cl.callTool({ name: "remote_list", arguments: {} })) as RemoteView[];
  assert.ok(rl[0]!.worker_reports[0]!.text.length < 400);
  assert.deepEqual(calls[0], { owner: "alpha" });
  const t = (await cl.listTools()).tools.find((x) => x.name === "task_status")!;
  assert.ok(!JSON.stringify(t.inputSchema).includes("pattern"));
  assert.ok(t.description && t.description.length > 0);
  await cl.close();
});

test("外向けの remote_list は切らない（返り値が変わらない）", async () => {
  const { createCenterServer } = await import("../src/server.js");
  const { parseConfig } = await import("../src/config.js");
  const big = view("alpha", [], [report("t", "done", 1, "z".repeat(5000))], { result: "r".repeat(9000) });
  const remotes = { list: () => [big] } as unknown as RemoteManager;
  const server = createCenterServer({ config: parseConfig({}, "/x/c.json"), supervisor: {} as never, link: {} as never, sessions: {} as never, remotes, follow: undefined, login: undefined });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "0" });
  await Promise.all([server.connect(st), client.connect(ct)]);
  const out = body(await client.callTool({ name: "remote_list", arguments: {} })) as RemoteView[];
  assert.equal(out[0]!.worker_reports[0]!.text.length, 5000);
  assert.equal(out[0]!.result!.length, 9000);
  assert.equal((out[0] as { truncated?: unknown }).truncated, undefined);
  await client.close();
});

const lenOf = (x: unknown): number => JSON.stringify(x, null, 2).length;
const withPrompt = (session: string, n: number, extra: Partial<RemoteView> = {}, id = session): RemoteView => {
  const v = view(session, [{ id: `t-${id}`, minAgo: 1 }], [], { remote_id: `c-1-${id}`, ...extra });
  v.pending[0]!.prompt = "p".repeat(n);
  return v;
};

test("limitRemoteList: pending の prompt が 50000 文字の cap 1 つでも 20000 文字以内。prompt を切った印", () => {
  const out = limitRemoteList([withPrompt("a", 50000)]);
  assert.ok(lenOf(out) <= REMOTE_LIST_TOTAL_MAX, `size ${lenOf(out)}`);
  const o = out[0] as RemoteView & { truncated?: { pending_prompts_cut: boolean } };
  assert.equal(o.truncated?.pending_prompts_cut, true);
  assert.ok(o.pending[0]!.prompt.length < 400);
});

test("limitRemoteList: conversation の error 文が巨大でも切る", () => {
  const conv = { started_at: iso(1), tasks: 1, last_error_text: "e".repeat(40000) } as unknown as RemoteView["conversation"];
  const out = limitRemoteList([withPrompt("a", 10, { conversation: conv })]);
  assert.ok(lenOf(out) <= REMOTE_LIST_TOTAL_MAX);
  assert.equal((out[0] as RemoteView & { truncated?: { conversation_cut: boolean } }).truncated?.conversation_cut, true);
});

test("limitRemoteList: prompt 1000 文字の cap 30 個 → 20000 文字以内。cap の件数が落ち、omitted_remotes の印が付く。古い cap から落ちる", () => {
  const views = Array.from({ length: 30 }, (_, i) => withPrompt(`s${i}`, 1000, { createdAt: iso(1000 - i) }, `${i}`));
  const out = limitRemoteList(views, 3000);
  assert.ok(lenOf(out) <= 3000, `size ${lenOf(out)}`);
  const last = out[out.length - 1] as { omitted_remotes?: number };
  assert.ok((last.omitted_remotes ?? 0) > 0);
  const keptIds = out.slice(0, -1).map((v) => (v as RemoteView).remote_id);
  assert.ok(!keptIds.includes("c-1-0"), "最も古い cap は落ちる");
  assert.ok(keptIds.includes("c-1-29"), "最も新しい cap は残る");
  assert.equal(keptIds.length + (last.omitted_remotes ?? 0), 30);
  // 既定の上限でも 30 個は収まる
  assert.ok(lenOf(limitRemoteList(views)) <= REMOTE_LIST_TOTAL_MAX);
});

test("limitRemoteList: 切る前が 20010 文字付近で、report 落としでは足りず fallback（result 縮め）の段を通る。note を付けても 20000 文字以内", () => {
  // report 無し・prompt 短し・result だけが 2000 文字で並ぶ cap を、上限の直上になるまで増やす。
  const mk = (i: number): RemoteView => withPrompt(`s${i}`, 10, { result: "r".repeat(1990), createdAt: iso(500 - i) }, `${i}`);
  let n = 1;
  while (lenOf(limitRemoteList(Array.from({ length: n }, (_, i) => mk(i)), 1e9)) <= REMOTE_LIST_TOTAL_MAX + 0) n++;
  const views = Array.from({ length: n }, (_, i) => mk(i));
  const base = lenOf(limitRemoteList(views, 1e9));
  assert.ok(base > REMOTE_LIST_TOTAL_MAX && base < REMOTE_LIST_TOTAL_MAX + 3000, `base ${base}`);
  const out = limitRemoteList(views);
  assert.ok(lenOf(out) <= REMOTE_LIST_TOTAL_MAX, `size ${lenOf(out)}`);
  const first = out[0] as RemoteView & { truncated?: { result_cut: boolean; note: string } };
  assert.equal(first.truncated?.result_cut, true);
  assert.ok(first.result!.length < 400, "fallback で result が縮む");
  assert.ok(out.length === views.length, "cap は落とさず result の縮めで収まる");
});
