import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, defineEventHandler, toNodeListener, toWebRequest } from "h3";
import { isServerReply, parseServerCommand, type ServerCommand } from "@agent-hand/bantou-protocol";
import {
  SCHEMA_DISCOVERY_HEADER,
  createOpenspecMcpGate,
  createUnconfiguredGate,
  judgeStep,
  openspecHeaders,
} from "../../../../server/utils/bantou/change-gate";
import { createAdmission } from "../../../../server/utils/bantou/change-resources";
import { executeChange, isChangeCommand, type ChangeCommand } from "../../../../server/utils/bantou/change-commands";
import { createChangeNotifier } from "../../../../server/utils/bantou/change-notify";
import { createChangeRunner, type ChangeNotice, type LaunchResult } from "../../../../server/utils/bantou/change-runner";
import { createChangeStore } from "../../../../server/utils/bantou/change-store";
import { setChangeReportHandler } from "../../../../server/utils/bantou/change-bridge";
import { loadConfig } from "../../../../server/utils/bantou/config";
import { handleMcpRequest, startMcpListener } from "../../../../server/utils/bantou/mcp";

// -- judgeStep ---------------------------------------------------------------

test("judgeStep: artifact は done だけ、apply は complete だけが通る。何も返らなければ通らない", () => {
  assert.deepEqual(judgeStep({ artifact: "done" }), { passed: true });
  assert.deepEqual(judgeStep({ apply: { done: 3, total: 3, complete: true } }), { passed: true });
  assert.deepEqual(judgeStep({ artifact: "done", apply: { done: 3, total: 3, complete: true } }), { passed: true });
  for (const a of ["ready", "blocked"] as const) {
    const v = judgeStep({ artifact: a });
    assert.equal(v.passed, false);
    assert.match(v.reason!, new RegExp(a));
  }
  const p = judgeStep({ apply: { done: 1, total: 4, complete: false } });
  assert.equal(p.passed, false);
  assert.match(p.reason!, /1\/4/);
  // 両方付く時は両方満たす事。通らない中身は全部書く
  const both = judgeStep({ artifact: "blocked", apply: { done: 0, total: 2, complete: false } });
  assert.equal(both.passed, false);
  assert.match(both.reason!, /blocked/);
  assert.match(both.reason!, /0\/2/);
  assert.equal(judgeStep({}).passed, false);
});

test("openspec-mcp への口: x-schema-discovery は JSON 1 本（mcpServers の 1 件分）。問い合わせの形は未確定なので status は投げる", async () => {
  const spec = { type: "http" as const, url: "https://center.invalid/schema", headers: { authorization: "Bearer x" } };
  const h = openspecHeaders(spec, { "x-other": "1" });
  assert.equal(SCHEMA_DISCOVERY_HEADER, "x-schema-discovery");
  assert.deepEqual(JSON.parse(h["x-schema-discovery"]!), spec);
  assert.equal(h["x-other"], "1");
  const gate = createOpenspecMcpGate({ url: "https://openspec.invalid/mcp", schemaDiscovery: spec });
  assert.equal(gate.unavailable(), undefined);
  assert.deepEqual(JSON.parse(gate.headers()[SCHEMA_DISCOVERY_HEADER]!), spec);
  await assert.rejects(() => gate.status("c", "r"), /プロトコル待ち/);
  const none = createUnconfiguredGate();
  assert.match(none.unavailable()!, /openspecMcp/);
  await assert.rejects(() => none.status("c", "r"));
});

// -- admission ---------------------------------------------------------------

const sample = (mem_free: number) => ({ at: "", load1: 0, load5: 0, load15: 0, cpus: 1, mem_total: 1000, mem_free, disk_total: null, disk_free: null, workers: 0 });

test("admission: 値を置かなければ上限なし。置けば並行数とメモリの空きで判定する", () => {
  const none = createAdmission({}, () => sample(0));
  assert.equal(none.canStart(1000), true);
  assert.equal(none.blockedReason(1000), undefined);
  const par = createAdmission({ maxParallelWorkers: 2 }, () => null);
  assert.equal(par.canStart(1), true);
  assert.equal(par.canStart(2), false);
  assert.match(par.blockedReason(2)!, /上限（2）/);
  let free = 100;
  const mem = createAdmission({ minFreeMemoryBytes: 100 }, () => sample(free));
  assert.equal(mem.canStart(0), true, "下限ちょうどは起こせる");
  free = 99;
  assert.equal(mem.canStart(0), false);
  assert.match(mem.blockedReason(0)!, /下限/);
  const unknown = createAdmission({ minFreeMemoryBytes: 100 }, () => null);
  assert.equal(unknown.canStart(0), true, "測れていない時は止めない");
});

// -- commands ----------------------------------------------------------------

async function withCommandRunner(fn: (runner: ReturnType<typeof createChangeRunner>, notices: ChangeNotice[]) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "bantou-change-cmd-test-"));
  const store = createChangeStore(dir, () => {});
  try {
    const notices: ChangeNotice[] = [];
    const runner = createChangeRunner({
      store,
      gate: { unavailable: () => undefined, status: async () => ({ artifact: "done" }) },
      admission: createAdmission({}, () => null),
      launch: () => new Promise<LaunchResult>(() => {}),
      stopWorker: async () => ({ stopped: true }),
      notify: async (_t, n) => void notices.push(n),
      log: () => {},
    });
    await fn(runner, notices);
    await store.flush();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const parse = (o: object): ChangeCommand => {
  const c = parseServerCommand(JSON.stringify({ bantou: 1, ...o })) as ServerCommand | null;
  assert.ok(c && isChangeCommand(c), JSON.stringify(o));
  return c;
};

test("change の指示: 返信は protocol の型に合い、register → status → reply 失敗 → stop の流れが通る", async () => {
  await withCommandRunner(async (runner) => {
    const from = { id: "p1", name: "bantou-center" };
    const ctx = { runner, from, board: () => ({ queued: 0 }) };
    const reg = await executeChange(parse({ type: "register_change", change_id: "ch1", scope: ["a", "b"], repo: "https://x.invalid/r.git", notify_id: "n1" }), ctx);
    assert.ok(isServerReply(reg));
    assert.deepEqual(reg, { bantou: 1, type: "register_change_result", ok: true, change_id: "ch1", accepted: true, state: "in_progress" });

    const st = await executeChange(parse({ type: "change_status", change_id: "ch1" }), ctx);
    assert.ok(isServerReply(st));
    assert.equal(st.type, "change_status_result");
    if (st.type === "change_status_result") {
      assert.equal(st.changes[0]!.steps[0]!.worker_id, "ch1-s0");
      assert.deepEqual(st.board, { queued: 0 });
    }
    const all = await executeChange(parse({ type: "change_status" }), ctx);
    assert.ok(isServerReply(all) && all.type === "change_status_result" && all.changes.length === 1);

    const dup = await executeChange(parse({ type: "register_change", change_id: "ch1", scope: ["a"], repo: "r", notify_id: "n1" }), ctx);
    assert.ok(isServerReply(dup));
    assert.equal(dup.type, "error");
    if (dup.type === "error") assert.deepEqual([dup.ok, dup.command, dup.change_id], [false, "register_change", "ch1"]);

    const bad = await executeChange(parse({ type: "change_reply", change_id: "ch1", worker_id: "ch1-s0", text: "x" }), ctx);
    assert.ok(isServerReply(bad));
    if (bad.type === "error") assert.deepEqual([bad.command, bad.change_id, bad.worker_id], ["change_reply", "ch1", "ch1-s0"]);
    else assert.fail("error のはず");

    const noSuch = await executeChange(parse({ type: "change_status", change_id: "zz" }), ctx);
    assert.equal(noSuch.type, "error");

    const stop = await executeChange(parse({ type: "stop_change", change_id: "ch1" }), ctx);
    assert.ok(isServerReply(stop));
    assert.deepEqual(stop, { bantou: 1, type: "stop_change_result", ok: true, change_id: "ch1", stopped: true });
  });
});

test("change の指示: 送ってきた center が通知先として記録される", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bantou-change-cmd2-test-"));
  const store = createChangeStore(dir, () => {});
  try {
    const seen: Array<unknown> = [];
    const runner = createChangeRunner({
      store,
      gate: { unavailable: () => undefined, status: async () => ({ artifact: "done" }) },
      admission: createAdmission({}, () => null),
      launch: () => new Promise<LaunchResult>(() => {}),
      stopWorker: async () => ({ stopped: true }),
      notify: async (to) => void seen.push(to),
      log: () => {},
    });
    await executeChange(parse({ type: "register_change", change_id: "ch1", scope: ["a"], repo: "r", notify_id: "n9" }), { runner, from: { id: "peer-1", name: "bantou-center" } });
    // 別の peer id から stop が来たら、その peer を通知先にする（center の再起動後）
    await executeChange(parse({ type: "stop_change", change_id: "ch1" }), { runner, from: { id: "peer-2", name: "bantou-center" } });
    assert.deepEqual(seen, [{ notify_id: "n9", target: { id: "peer-2", name: "bantou-center" } }]);
    await store.flush();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// -- notifier ----------------------------------------------------------------

const progress = (): ChangeNotice => ({ bantou: 1, type: "change_progress", notify_id: "n1", change_id: "c", step: 0, change_state: "completed", step_state: "passed", at: "t" });

test("通知: 名前の peer の今の id へ送る。覚えている id がまだ居ればそれ、居なければ最後に登録した同名の peer", async () => {
  const sent: string[] = [];
  let peers: Array<{ id: string; registered_at?: string }> = [{ id: "old", registered_at: "1" }];
  const notify = createChangeNotifier({ resolvePeers: async () => peers, send: async (to) => void sent.push(to), log: () => {} });
  await notify({ notify_id: "n1", target: { id: "old", name: "bantou-center" } }, progress());
  peers = [{ id: "a", registered_at: "2" }, { id: "b", registered_at: "3" }];
  await notify({ notify_id: "n1", target: { id: "old", name: "bantou-center" } }, progress());
  peers = [];
  await notify({ notify_id: "n1", target: { id: "old", name: "bantou-center" } }, progress());
  await notify({ notify_id: "n1", target: { id: "plain" } }, progress());
  assert.deepEqual(sent, ["old", "b", "old", "plain"]);
});

test("通知: 引けなくても覚えている id へ送る。通知先が無ければ送らない", async () => {
  const sent: string[] = [];
  const logs: string[] = [];
  const notify = createChangeNotifier({
    resolvePeers: async () => {
      throw new Error("broker に届かない");
    },
    send: async (to) => void sent.push(to),
    log: (m) => logs.push(m),
  });
  await notify({ notify_id: "n1", target: { id: "p", name: "bantou-center" } }, progress());
  await notify({ notify_id: "n1" }, progress());
  assert.deepEqual(sent, ["p"]);
  assert.equal(logs.length, 2);
});

// -- config ------------------------------------------------------------------

async function load(obj: unknown) {
  const dir = await mkdtemp(join(tmpdir(), "bantou-change-config-test-"));
  try {
    const p = join(dir, "config.json");
    await writeFile(p, JSON.stringify(obj));
    return await loadConfig(p);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("config: change / openspecMcp は省略できる（既定は上限なし・openspec-mcp なし）。置けば検証して返す", async () => {
  const none = await load({ workspace: "/w" });
  assert.equal(none.change, undefined);
  assert.equal(none.openspecMcp, undefined);
  assert.ok(!("change" in none) && !("openspecMcp" in none));
  const c = await load({
    workspace: "/w",
    change: { maxParallelWorkers: 3, minFreeMemoryBytes: 1024 },
    openspecMcp: { url: "https://o.invalid/mcp", schemaDiscovery: { type: "http", url: "https://c.invalid/s", headers: { a: "b" } } },
  });
  assert.deepEqual(c.change, { maxParallelWorkers: 3, minFreeMemoryBytes: 1024 });
  assert.deepEqual(c.openspecMcp, { url: "https://o.invalid/mcp", schemaDiscovery: { type: "http", url: "https://c.invalid/s", headers: { a: "b" } } });
  assert.deepEqual((await load({ workspace: "/w", change: {} })).change, {});
});

test("config: change の値は 1 以上の整数。schemaDiscovery の type は http だけ", async () => {
  await assert.rejects(() => load({ workspace: "/w", change: { maxParallelWorkers: 0 } }), /maxParallelWorkers/);
  await assert.rejects(() => load({ workspace: "/w", change: { minFreeMemoryBytes: 1.5 } }), /minFreeMemoryBytes/);
  await assert.rejects(() => load({ workspace: "/w", change: [] }), /change/);
  await assert.rejects(() => load({ workspace: "/w", openspecMcp: { url: "u", schemaDiscovery: { type: "stdio", url: "x" } } }), /http/);
  await assert.rejects(() => load({ workspace: "/w", openspecMcp: { url: "", schemaDiscovery: { type: "http", url: "x" } } }), /openspecMcp.url/);
  await assert.rejects(() => load({ workspace: "/w", openspecMcp: { url: "u", schemaDiscovery: { type: "http", url: "x", headers: { a: 1 } } } }), /headers/);
});

// -- store -------------------------------------------------------------------

test("store: 壊れた記録は飛ばして残りを読む。書き込みは順に行われ、最後の値が残る", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bantou-change-store-test-"));
  try {
    const logs: string[] = [];
    const store = createChangeStore(dir, (m) => logs.push(m));
    const rec = { change_id: "c1", state: "in_progress" as const, repo: "r", notify_id: "n", scope_start: 0, steps: [{ ref: "a", state: "queued" as const, launches: 0 }], updated_at: "1" };
    for (let i = 0; i < 20; i++) void store.save({ ...rec, updated_at: String(i) });
    await store.flush();
    await store.save({ ...rec, change_id: "c2" });
    await writeFile(join(dir, "changes", "c2", "change.json"), "{ broken");
    const all = await store.loadAll();
    assert.deepEqual(all.map((r) => [r.change_id, r.updated_at]), [["c1", "19"]]);
    assert.equal(logs.length, 1);
    assert.match(logs[0]!, /c2/);
    assert.match(await readFile(join(dir, "changes", "c1", "change.json"), "utf8"), /"change_id": "c1"/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// -- mcp: change の worker の report ------------------------------------------

function rpc(url: string, body: object, headers: Record<string, string>): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
    body: JSON.stringify(body),
  });
}

test("mcp: x-bantou-change-id と x-bantou-worker-id の worker の report は change の受け口へ。cap-id は要らず、bash も載る", async () => {
  const got: Array<[string, string, string, string]> = [];
  setChangeReportHandler(async (c, w, k, t) => {
    got.push([c, w, k, t]);
  });
  const app = createApp().use("/mcp", defineEventHandler((e) => handleMcpRequest(toWebRequest(e))));
  const l = await startMcpListener(toNodeListener(app), { port: 0, bind: "127.0.0.1" });
  try {
    const url = `http://127.0.0.1:${l.port}/mcp`;
    const h = { "x-bantou-change-id": "ch1", "x-bantou-worker-id": "ch1-s0" };
    const tools = (await (await rpc(url, { jsonrpc: "2.0", id: 1, method: "tools/list" }, h)).json()) as { result: { tools: Array<{ name: string }> } };
    assert.deepEqual(tools.result.tools.map((t) => t.name), ["report", "bash"]);
    const call = (kind: string, text: string) => ({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "report", arguments: { kind, text } } });
    const ok = (await (await rpc(url, call("ask", "どっち？"), h)).json()) as { result: { content: Array<{ text: string }>; isError?: boolean } };
    assert.equal(ok.result.content[0]!.text, "accepted");
    assert.deepEqual(got, [["ch1", "ch1-s0", "ask", "どっち？"]]);
    // worker-id が無ければ拒否
    const ng = (await (await rpc(url, call("done", "x"), { "x-bantou-change-id": "ch1" })).json()) as { result: { isError?: boolean } };
    assert.equal(ng.result.isError, true);
    assert.equal(got.length, 1);
    // 受け口が投げたら isError
    setChangeReportHandler(async () => {
      throw new Error("質問を受けられない");
    });
    const bad = (await (await rpc(url, call("ask", "x"), h)).json()) as { result: { content: Array<{ text: string }>; isError?: boolean } };
    assert.equal(bad.result.isError, true);
    assert.match(bad.result.content[0]!.text, /質問を受けられない/);
    // 受け口が無ければ拒否
    setChangeReportHandler(undefined);
    const none = (await (await rpc(url, call("ask", "x"), h)).json()) as { result: { isError?: boolean } };
    assert.equal(none.result.isError, true);
  } finally {
    setChangeReportHandler(undefined);
    await l.close();
  }
});
