/**
 * リセッション（docs/design/resession.md）。偽の claude（pty wrapper の偽物）・本物の supervisor / SessionManager / core / Resessioner /
 * 外部記憶への書き込み・偽の memory で、申告 → 引継ぎの保存 → 再起動 → 引継ぎを引いて続く、を通す。
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { afterEach, beforeEach, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { parseConfig, type Config } from "../src/config.js";
import { createCore } from "../src/core.js";
import { createCenterMemoryEvents } from "../src/memory-events.js";
import { createRemoteControlSupervisor, type ChildLike, type SpawnImpl } from "../src/remote-control.js";
import { AWAIT_START_STALE_MS, createResessioner, RESESSION_DIVIDER, type Resessioner, type ResessionDeps } from "../src/resession.js";
import { MEMORY_BODY_MAX } from "../src/memory.js";
import type { SessionInfo } from "../src/sessions.js";
import { createSessionActivityTracker } from "../src/session-activity.js";
import { createSessionTokens } from "../src/session-auth.js";
import { createSessionManager, type SessionManager } from "../src/sessions.js";
import { createJsonListStore } from "../src/store.js";
import { registerSessionTools } from "../src/tools.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { startFakeMemory, type FakeMemory } from "./helpers/fake-memory.js";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
async function until(fn: () => boolean, ms = 4000): Promise<void> {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error("until: タイムアウト");
    await sleep(10);
  }
}

/** 偽の claude を包む pty wrapper。center から来た行を溜め、stop を受けたら止まる。 */
class FakeWrapper extends EventEmitter implements ChildLike {
  pid: number | undefined = 3000 + Math.floor(Math.random() * 1000);
  stdout = new PassThrough();
  stderr = new PassThrough();
  lines: Record<string, unknown>[] = [];
  private partial = "";
  stdin: Writable = new Writable({
    write: (chunk, _enc, cb) => {
      this.partial += String(chunk);
      const parts = this.partial.split("\n");
      this.partial = parts.pop() ?? "";
      for (const p of parts) {
        const m = JSON.parse(p) as Record<string, unknown>;
        this.lines.push(m);
        if (m.t === "stop") setImmediate(() => this.finish());
      }
      cb();
    },
  });
  kill(): boolean {
    return true;
  }
  say(msg: Record<string, unknown>): void {
    this.stdout.write(`${JSON.stringify(msg)}\n`);
  }
  connect(id: string): void {
    this.say({ t: "text", data: `/remote-control is active · https://claude.ai/code/session_${id}\n` });
  }
  finish(): void {
    this.say({ t: "exit", code: 0, signal: null });
    this.emit("exit", 0, null);
    this.stdout.end();
    this.stderr.end();
    setImmediate(() => this.emit("close", 0, null));
  }
  inputs(): string[] {
    return this.lines.filter((l) => l.t === "input").map((l) => Buffer.from(l.data as string, "base64").toString());
  }
  stopped(): boolean {
    return this.lines.some((l) => l.t === "stop");
  }
}

let dir: string;
let cfg: Config;
let launches: { args: string[]; child: FakeWrapper }[];
let mem: FakeMemory;
let memDown = false;

interface Rig {
  core: ReturnType<typeof createCore>;
  sessions: SessionManager;
  res: Resessioner;
  tracker: ReturnType<typeof createSessionActivityTracker>;
  remote: { running: number; waitingReply: number };
  logs: string[];
  /** supervisor.start の呼び出し（resume の有無）。 */
  starts: { resume: boolean }[];
  /** sessions.events に流れた reason。 */
  published: string[];
  /** 身代わり peer の置き外し（onSleepChange）の履歴。 */
  standIn: string[];
  /** hook を center が受ける順（activity → resession）で流す。 */
  hook: (payload: Record<string, unknown>) => void;
  startedAt: () => string | null;
  close: () => Promise<void>;
}

async function rig(opts: { withMemory?: boolean; failFresh?: boolean } = {}): Promise<Rig> {
  const withMemory = opts.withMemory !== false;
  const spawnImpl: SpawnImpl = (_cmd, args) => {
    const child = new FakeWrapper();
    launches.push({ args, child });
    return child;
  };
  const core = createCore();
  const logs: string[] = [];
  const memoryDef = withMemory ? { type: "http", url: mem.url, headers: { Authorization: `Bearer ${mem.token}` } } : undefined;
  const sup = createRemoteControlSupervisor({
    config: cfg,
    log: (m) => void logs.push(m),
    spawnImpl,
    ...(memoryDef ? { memoryOf: () => memoryDef } : {}),
    wrapper: { core, tokens: createSessionTokens(), path: "/fake/bantou-pty-wrapper", mcpUrl: () => "http://127.0.0.1:4567/mcp/session", statusLineSelf: ["/fake/bantou-center"] },
  });
  // --continue 無しの起動（リセッションの新しい会話）だけ失敗させられる supervisor
  const starts: { resume: boolean }[] = [];
  const published: string[] = [];
  const supervisor = {
    ...sup,
    start: async (name: string, o?: { resume?: boolean }) => {
      starts.push({ resume: o?.resume === true });
      if (opts.failFresh && starts.length > 1 && o?.resume !== true) throw new Error("新しい会話で起動できない");
      return sup.start(name, o);
    },
  };
  const tracker = createSessionActivityTracker();
  const standIn: string[] = [];
  const remote = { running: 0, waitingReply: 0 };
  const sessions = createSessionManager({
    config: cfg,
    supervisor,
    events: { publish: (e: { reason: string }) => void published.push(e.reason) } as never,
    store: createJsonListStore(join(dir, "sessions.json"), () => {}),
    log: (m) => void logs.push(m),
    waitMs: 0,
    activity: (name, startedAt, running) => tracker.get(name, startedAt, running),
    remote: () => ({ ...remote }),
    onSleepChange: (n, sl) => void standIn.push(`${n}:${sl}`),
  });
  const memoryEvents = createCenterMemoryEvents({ memoryOf: () => memoryDef, log: (m) => void logs.push(m) });
  const res = createResessioner({
    info: (name) => sessions.list().find((x) => x.name === name),
    restartFresh: (name) => sessions.restartFresh(name),
    saveToMemory: (name, h) => memoryEvents.handoff(name, h, 3000),
    core,
    dir: join(dir, "handoffs"),
    log: (m) => void logs.push(m),
    submitDelayMs: 20,
  });
  const startedAt = (): string | null => sessions.list().find((s) => s.name === "pm1")?.startedAt ?? null;
  return {
    core, sessions, res, tracker, remote, logs, starts, published, standIn, startedAt,
    // daemon.ts の onHook と同じ順: 作業状態 → resession
    hook: (payload) => {
      tracker.apply("pm1", payload, startedAt());
      res.onHook("pm1", payload);
    },
    close: async () => {
      memoryEvents.close();
      await sup.shutdown();
    },
  };
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "center-resession-"));
  cfg = parseConfig({ workspace: join(dir, "ws"), remoteControl: { claude: "fake-claude", restartDelayMs: 30, maxRestarts: 2, stopGraceMs: 200 }, logDir: join(dir, "logs") }, join(dir, "c.json"));
  launches = [];
  memDown = false;
  mem = await startFakeMemory();
});
afterEach(async () => {
  await mem.close();
  await rm(dir, { recursive: true, force: true });
});

const hookOf = (event: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({ hook_event_name: event, ...extra });

/** 起動して接続し、利用者の発言で working にする（tool を呼ぶのは turn の中）。 */
async function boot(r: Rig): Promise<FakeWrapper> {
  await r.sessions.create({ name: "pm1" });
  const w = launches[launches.length - 1]!.child;
  w.connect("one");
  await until(() => r.sessions.list()[0]?.state === "connected");
  r.hook(hookOf("SessionStart", { source: "startup" }));
  r.hook(hookOf("UserPromptSubmit", { prompt: "続きをやって" }));
  assert.equal(r.sessions.list()[0]!.activity, "working");
  return w;
}

const HANDOFF = "[引継ぎ]\n仕掛かり: x\n止まっている事: なし\n次の一手: y\n[決定と未決]\nU1 は C\n[今の窓口]\nmaster-cap";

test("流れ: 申告 → 引継ぎが memory に保存 → turn の終わりで新しい会話に再起動（区切りの行）→ 最初の入力 → memory から引いて続く", async () => {
  const r = await rig();
  const w1 = await boot(r);
  const got = await r.res.request("pm1", HANDOFF);
  assert.equal(got.accepted, true);
  assert.equal(got.stored, "memory");
  // 受理を待ってから返っている: memory に handoff が記録済み、本文は省略なし
  const rec = mem.recorded().filter((e) => e.kind === "handoff");
  assert.equal(rec.length, 1);
  assert.equal(rec[0]!.body, HANDOFF);
  assert.equal(rec[0]!.eventId, got.handoff_id);
  assert.equal(rec[0]!.agentId, "pm1");
  // tool の応答だけでは再起動しない（turn の途中）
  await sleep(50);
  assert.equal(launches.length, 1);
  assert.equal(w1.stopped(), false);
  assert.equal(r.res.pending("pm1"), true);

  // turn の終わり（Stop）で再起動: 止めて、--continue 無しで起動し直す。区切りの行が core に積まれる
  r.hook(hookOf("Stop", { last_assistant_message: "再起動する" }));
  await until(() => launches.length === 2);
  assert.equal(w1.stopped(), true);
  assert.ok(!launches[1]!.args.includes("--continue"), "新しい会話（--continue 無し）");
  assert.ok(!launches[0]!.args.includes("--continue"));
  // 再起動の間は身代わり peer を置き、新しい claude が接続したら外す（U6 の A）
  await until(() => r.standIn.length === 2);
  assert.deepEqual(r.standIn, ["pm1:true", "pm1:false"]);
  const evs: string[] = [];
  r.core.subscribe("pm1", undefined, (e) => e.type === "chunk" && evs.push(e.data.toString()))!();
  assert.ok(evs.includes(RESESSION_DIVIDER), "区切りの行");
  // 起動し直した claude が接続しても、SessionStart（startup）を見るまで入力は送らない
  const w2 = launches[1]!.child;
  w2.connect("two");
  await sleep(60);
  assert.deepEqual(w2.inputs(), []);
  r.hook(hookOf("SessionStart", { source: "startup" }));
  await until(() => w2.inputs().length === 2);
  const [text, enter] = w2.inputs();
  assert.equal(enter, "\r");
  assert.ok(text!.includes("リセッションで再起動した"));
  assert.ok(text!.includes(got.handoff_id));
  assert.ok(text!.includes("mcp__memory__handoff"));
  assert.ok(!text!.includes("仕掛かり: x"), "memory に保存した時は本文を入力に入れない（session が引く）");
  // 偽の claude が入力の id で memory から引いて、続きを読める（agent = session 名）
  const id = /eventId=(\S+) /.exec(text!)![1]!;
  const client = new Client({ name: "fake-claude", version: "0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(mem.url), { requestInit: { headers: { Authorization: `Bearer ${mem.token}`, "X-Agent-Id": "pm1" } } }));
  const out = (await client.callTool({ name: "handoff", arguments: { eventId: id } })) as { content: { text: string }[] };
  assert.equal((JSON.parse(out.content[0]!.text) as { body: string }).body, HANDOFF);
  await client.close();
  // 1 回だけ: 印は消え、2 回目の SessionStart では送らない。記録に渡し済みが付く
  assert.equal(r.res.pending("pm1"), false);
  r.hook(hookOf("SessionStart", { source: "startup" }));
  await sleep(80);
  assert.equal(w2.inputs().length, 2);
  await until(() => r.res.record("pm1")?.deliveredAt !== undefined);
  assert.equal(r.res.record("pm1")?.stored, "memory");
  await r.close();
});

test("memory に届かない時: 引継ぎを file に残して受理し、最初の入力に本文を入れる", async () => {
  mem.setDown(true);
  const r = await rig();
  const w1 = await boot(r);
  const got = await r.res.request("pm1", HANDOFF);
  assert.equal(got.stored, "file");
  const file = JSON.parse(await readFile(join(dir, "handoffs", "pm1.json"), "utf8")) as { id: string; body: string; stored: string };
  assert.equal(file.body, HANDOFF);
  assert.equal(file.id, got.handoff_id);
  r.hook(hookOf("Stop"));
  await until(() => launches.length === 2);
  assert.equal(w1.stopped(), true);
  launches[1]!.child.connect("two");
  r.hook(hookOf("SessionStart", { source: "startup" }));
  await until(() => launches[1]!.child.inputs().length === 2);
  assert.ok(launches[1]!.child.inputs()[0]!.includes("仕掛かり: x"));
  await r.close();
});

test("memory の設定が無い構成: file に保存して進む", async () => {
  const r = await rig({ withMemory: false });
  await boot(r);
  const got = await r.res.request("pm1", HANDOFF);
  assert.equal(got.stored, "file");
  assert.equal(mem.calls.length, 0);
  await r.close();
});

test("安全確認: 利用者の入力待ち・未完了の remote・未返答の worker_reply・申告済み・空の本文は断る（再起動しない）", async () => {
  const r = await rig();
  await boot(r);
  await assert.rejects(r.res.request("pm1", "  "), /空/);
  r.remote.running = 1;
  await assert.rejects(r.res.request("pm1", HANDOFF), /未完了の remote/);
  r.remote.running = 0;
  r.remote.waitingReply = 2;
  await assert.rejects(r.res.request("pm1", HANDOFF), /worker_reply/);
  r.remote.waitingReply = 0;
  r.hook(hookOf("PermissionRequest"));
  await assert.rejects(r.res.request("pm1", HANDOFF), /needs-input/);
  r.hook(hookOf("PostToolUse"));
  assert.equal(mem.recorded().filter((e) => e.kind === "handoff").length, 0, "断った時は保存しない");
  await r.res.request("pm1", HANDOFF);
  await assert.rejects(r.res.request("pm1", HANDOFF), /途中/);
  await assert.rejects(r.res.request("nobody", HANDOFF), /未定義/);
  await r.close();
});

test("Stop の後、止める直前に利用者の入力で working に戻っていたら見送る（印を戻す。再起動しない）", async () => {
  const r = await rig();
  await boot(r);
  await r.res.request("pm1", HANDOFF);
  // Stop を受けた直後・実行（次の tick）の前に利用者の発言が来た
  r.hook(hookOf("Stop"));
  r.tracker.apply("pm1", hookOf("UserPromptSubmit"), r.startedAt());
  await sleep(100);
  assert.equal(launches.length, 1, "再起動しない");
  assert.equal(r.res.pending("pm1"), false);
  assert.ok(r.logs.some((l) => l.includes("リセッション見送り")));
  await r.close();
});

test("再起動に失敗したら印を戻す（引継ぎは保存済みのまま。もう一度申告できる）", async () => {
  const r = await rig();
  await boot(r);
  await r.res.request("pm1", HANDOFF);
  const sup = r.sessions;
  const orig = sup.restartFresh;
  sup.restartFresh = async () => {
    throw new Error("起動できない");
  };
  r.hook(hookOf("Stop"));
  await until(() => r.logs.some((l) => l.includes("再起動に失敗")));
  assert.equal(r.res.pending("pm1"), false);
  sup.restartFresh = orig;
  await r.close();
});

test("tool session_resession（/mcp/session）: 呼び出し元 session を自分として申告し、結果を返す。他の session を指す引数は無い", async () => {
  const calls: string[] = [];
  const server = new McpServer({ name: "t", version: "0" });
  registerSessionTools(server, {
    remotes: {} as never,
    owner: "pm1",
    resession: { request: async (s, h) => (calls.push(`${s}:${h}`), { accepted: true, handoff_id: "h1", stored: "memory", restart: "x" }) },
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: "c", version: "0" });
  await client.connect(b);
  const tools = (await client.listTools()).tools;
  const t = tools.find((x) => x.name === "session_resession")!;
  assert.deepEqual(Object.keys((t.inputSchema as { properties: object }).properties), ["handoff"]);
  const out = (await client.callTool({ name: "session_resession", arguments: { handoff: "H" } })) as { content: { text: string }[]; isError?: boolean };
  assert.deepEqual(calls, ["pm1:H"]);
  assert.equal(JSON.parse(out.content[0]!.text).handoff_id, "h1");
  // 断られた時は isError
  const server2 = new McpServer({ name: "t", version: "0" });
  registerSessionTools(server2, { remotes: {} as never, owner: "pm1", resession: { request: async () => { throw new Error("断る"); } } });
  const [c, d] = InMemoryTransport.createLinkedPair();
  await server2.connect(c);
  const client2 = new Client({ name: "c", version: "0" });
  await client2.connect(d);
  const bad = (await client2.callTool({ name: "session_resession", arguments: { handoff: "H" } })) as { isError?: boolean };
  assert.equal(bad.isError, true);
  // resession を渡さない構成では tool が出ない
  const server3 = new McpServer({ name: "t", version: "0" });
  registerSessionTools(server3, { remotes: {} as never, owner: "pm1" });
  const [e, f] = InMemoryTransport.createLinkedPair();
  await server3.connect(e);
  const client3 = new Client({ name: "c", version: "0" });
  await client3.connect(f);
  assert.ok(!(await client3.listTools()).tools.some((x) => x.name === "session_resession"));
});

// ---- 再起動の失敗・見送り（本物の SessionManager） ----

test("再起動に失敗したら、元の会話（--continue）で起動し直す。止まったままにしない（設計 3.3 の U8: 次の起動は --continue）", async () => {
  const r = await rig({ failFresh: true });
  const w1 = await boot(r);
  await r.res.request("pm1", HANDOFF);
  r.hook(hookOf("Stop"));
  // 新しい会話の起動が失敗 → 元の会話で起動し直す（resume: true の start）
  await until(() => r.starts.length === 3);
  assert.deepEqual(r.starts, [{ resume: false }, { resume: false }, { resume: true }]);
  assert.equal(w1.stopped(), true);
  assert.equal(launches.length, 2, "元の会話の claude が 1 つ起動している");
  assert.ok(launches[1]!.args.includes("--continue"), "元の会話（--continue）");
  await until(() => r.logs.some((l) => l.includes("元の会話で再起動した")));
  assert.ok(r.logs.some((l) => l.includes("再起動に失敗")));
  assert.equal(r.res.pending("pm1"), false, "印は戻る");
  assert.ok(!r.published.includes("restarted"), "失敗は restarted を流さない");
  // 身代わりは外れている
  await until(() => r.standIn.length === 2);
  assert.deepEqual(r.standIn, ["pm1:true", "pm1:false"]);
  // 起動し直した元の会話の SessionStart（startup でない）では最初の入力を送らない
  launches[1]!.child.connect("back");
  r.hook(hookOf("SessionStart", { source: "resume" }));
  await sleep(60);
  assert.deepEqual(launches[1]!.child.inputs(), []);
  await r.close();
});

test("申告の後に利用者の入力が来て会話が進んだら、印を戻す。後の Stop で古い引継ぎのまま再起動しない（3.3 の 4 と同じ扱い）", async () => {
  const r = await rig();
  const w1 = await boot(r);
  await r.res.request("pm1", HANDOFF);
  assert.equal(r.res.pending("pm1"), true);
  // Stop が来ないまま（中断など）利用者が入力して、後の turn が走る
  r.hook(hookOf("UserPromptSubmit", { prompt: "やっぱり別の件" }));
  assert.equal(r.res.pending("pm1"), false);
  r.hook(hookOf("Stop"));
  await sleep(100);
  assert.equal(launches.length, 1, "再起動しない");
  assert.equal(w1.stopped(), false);
  assert.ok(r.logs.some((l) => l.includes("リセッション見送り（申告の後に利用者の入力）")));
  // もう一度申告すれば、新しい引継ぎで通る
  await r.res.request("pm1", HANDOFF);
  assert.equal(r.res.pending("pm1"), true);
  await r.close();
});

test("restartFresh: 眠っている session は再起動しない。成功したら restarted を流す", async () => {
  const r = await rig();
  await boot(r);
  await r.sessions.sleep("pm1");
  await assert.rejects(r.sessions.restartFresh("pm1"), /眠っている session は再起動しない/);
  assert.ok(!r.published.includes("restarted"));
  await r.sessions.wake("pm1");
  launches[launches.length - 1]!.child.connect("w");
  await r.sessions.restartFresh("pm1");
  assert.ok(r.published.includes("restarted"));
  await r.close();
});

// ---- Resessioner の単体（偽の info・保存・再起動。変異で生き残った処理の固定） ----

function unit(over: Partial<ResessionDeps> & { info?: Partial<SessionInfo> | null } = {}) {
  const base = { name: "pm1", state: "connected", sleeping: false, source: "session", activity: "working", remote: { running: 0, waitingReply: 0 } } as unknown as SessionInfo;
  const state = { info: over.info === null ? undefined : ({ ...base, ...(over.info ?? {}) } as SessionInfo), clock: 1_000_000 };
  const logs: string[] = [];
  const inputs: string[] = [];
  const saves: string[] = [];
  let restarts = 0;
  const res = createResessioner({
    info: () => state.info,
    restartFresh: over.restartFresh ?? (async () => void restarts++),
    saveToMemory: over.saveToMemory ?? (async (_s, h) => (saves.push(h.id), "memory")),
    core: { push: () => undefined, input: (_n, d) => (inputs.push(d.toString()), true) },
    dir: over.dir ?? join(dir, "unit-handoffs"),
    log: (m) => void logs.push(m),
    now: () => state.clock,
    submitDelayMs: 1,
    defer: (fn) => fn(),
  });
  return { res, state, logs, inputs, saves, restarts: () => restarts };
}

test("安全確認: session_create で作った session（source=session）以外・存在しない session は断る。保存しない", async () => {
  const u = unit({ info: { source: "config" } });
  await assert.rejects(u.res.request("pm1", HANDOFF), /session_create で作った session だけ/);
  assert.equal(u.saves.length, 0);
  const none = unit({ info: null });
  await assert.rejects(none.res.request("pm1", HANDOFF), /未定義の session/);
});

test("安全確認: スリープ中・動いていない state（stopped / failed など）は断る。保存しない", async () => {
  const sl = unit({ info: { sleeping: true, state: "stopped" } });
  await assert.rejects(sl.res.request("pm1", HANDOFF), /動いていない/);
  const st = unit({ info: { state: "stopped" } });
  await assert.rejects(st.res.request("pm1", HANDOFF), /動いていない（state=stopped）/);
  const ok = unit({ info: { state: "starting" } });
  await ok.res.request("pm1", HANDOFF);
  assert.equal(sl.saves.length + st.saves.length, 0);
});

test("本文の検査: NUL を含む・長すぎる（MEMORY_BODY_MAX 超）は断る。ちょうど上限は通る。保存しない", async () => {
  const u = unit();
  await assert.rejects(u.res.request("pm1", "a\0b"), /NUL/);
  await assert.rejects(u.res.request("pm1", "あ".repeat(MEMORY_BODY_MAX + 1)), /長すぎる/);
  assert.equal(u.saves.length, 0);
  await u.res.request("pm1", "あ".repeat(MEMORY_BODY_MAX));
  assert.equal(u.saves.length, 1);
});

test("二重申告: 申告前の確認で 2 回目は memory に書かれない（保存は 1 回）", async () => {
  const u = unit();
  await u.res.request("pm1", HANDOFF);
  await assert.rejects(u.res.request("pm1", HANDOFF + "2"), /途中/);
  assert.equal(u.saves.length, 1, "2 回目は保存まで進まない");
});

test("二重申告: 保存の await の間に別の申告が先に印を付けたら、保存後の確認で断る（印は 1 つ）", async () => {
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => (release = r));
  const saved: string[] = [];
  const u = unit({ saveToMemory: async (_s, h) => (saved.push(h.id), await gate, "memory") });
  const a = u.res.request("pm1", HANDOFF + "a");
  const b = u.res.request("pm1", HANDOFF + "b");
  await until(() => saved.length === 2); // 申告前の確認はどちらも通っている
  release();
  const rs = await Promise.allSettled([a, b]);
  assert.deepEqual(rs.map((x) => x.status).sort(), ["fulfilled", "rejected"]);
  assert.match(String((rs.find((x) => x.status === "rejected") as PromiseRejectedResult).reason), /申告済み/);
});

test("保存の間に状況が変わったら（needs-input）、保存後の確認で断る。印は付かない", async () => {
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => (release = r));
  const saved: string[] = [];
  const u = unit({ saveToMemory: async (_s, h) => (saved.push(h.id), await gate, "memory") });
  const p = u.res.request("pm1", HANDOFF);
  await until(() => saved.length === 1);
  u.state.info = { ...u.state.info!, activity: "needs-input" } as SessionInfo;
  release();
  await assert.rejects(p, /needs-input/);
  assert.equal(u.res.pending("pm1"), false);
});

test("file にも書けない時: memory に届かなければ断る（引継ぎを失うので）。memory に受理済みなら進める", async () => {
  // dir に file を指して mkdir を失敗させる
  const blocker = join(dir, "blocker");
  await writeFile(blocker, "x");
  const down = unit({ dir: join(blocker, "sub"), saveToMemory: async () => { throw new Error("届かない"); } });
  await assert.rejects(down.res.request("pm1", HANDOFF), /引継ぎを保存できない/);
  assert.equal(down.res.pending("pm1"), false, "断った時は印を付けない");
  const none = unit({ dir: join(blocker, "sub"), saveToMemory: async () => "none" });
  await assert.rejects(none.res.request("pm1", HANDOFF), /引継ぎを保存できない/);
  const ok = unit({ dir: join(blocker, "sub") });
  const got = await ok.res.request("pm1", HANDOFF);
  assert.equal(got.stored, "memory");
  assert.ok(ok.logs.some((l) => l.includes("記録 file を書けない")));
});

test("SessionStart は source=startup の時だけ最初の入力を送る（resume / compact・別の起動では送らない）。送る時は bracketed paste で包み、Enter は別に送る", async () => {
  const u = unit();
  await u.res.request("pm1", HANDOFF);
  u.state.info = { ...u.state.info!, activity: "idle" } as SessionInfo; // turn が終わった
  u.res.onHook("pm1", hookOf("Stop"));
  await until(() => u.restarts() === 1);
  assert.equal(u.res.pending("pm1"), true, "起動し直した後は SessionStart を待つ");
  for (const source of ["resume", "compact", "clear", undefined]) {
    u.res.onHook("pm1", hookOf("SessionStart", source === undefined ? {} : { source }));
  }
  await sleep(30);
  assert.deepEqual(u.inputs, []);
  assert.equal(u.res.pending("pm1"), true, "startup 以外では印を消さない");
  u.res.onHook("pm1", hookOf("SessionStart", { source: "startup" }));
  await until(() => u.inputs.length === 2);
  assert.ok(u.inputs[0]!.startsWith("\u001b[200~") && u.inputs[0]!.endsWith("\u001b[201~"), "bracketed paste で包む");
  assert.ok(u.inputs[0]!.includes("mcp__memory__handoff"));
  assert.equal(u.inputs[1], "\r");
});

test("awaiting-start は 5 分で古い物になる: それまでは申告を断り、過ぎたら pending でなくなり新しい申告で上書きできる", async () => {
  const u = unit();
  await u.res.request("pm1", HANDOFF);
  u.state.info = { ...u.state.info!, activity: "idle" } as SessionInfo; // turn が終わった
  u.res.onHook("pm1", hookOf("Stop"));
  await until(() => u.restarts() === 1);
  u.state.clock += AWAIT_START_STALE_MS; // ちょうどは古くない
  assert.equal(u.res.pending("pm1"), true);
  await assert.rejects(u.res.request("pm1", HANDOFF + "2"), /途中/);
  u.state.clock += 1;
  assert.equal(u.res.pending("pm1"), false);
  const got = await u.res.request("pm1", HANDOFF + "2");
  assert.equal(got.accepted, true);
  assert.equal(u.saves.length, 2);
});
