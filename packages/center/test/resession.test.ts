/**
 * リセッション（docs/design/resession.md）。偽の claude（pty wrapper の偽物）・本物の supervisor / SessionManager / core / Resessioner /
 * 外部記憶への書き込み・偽の memory で、申告 → 引継ぎの保存 → 再起動 → 引継ぎを引いて続く、を通す。
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
import { AWAIT_START_STALE_MS, createResessioner, firstInputText, RESESSION_DIVIDER, WAKE_DIVIDER, type Resessioner, type ResessionDeps } from "../src/resession.js";
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
  /** 次の「--continue 無しの起動」を 1 回だけ失敗させる（スリープから起こす起動の失敗の test）。 */
  ctl: { failNextFresh: boolean };
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
  const ctl = { failNextFresh: false };
  const published: string[] = [];
  const supervisor = {
    ...sup,
    start: async (name: string, o?: { resume?: boolean }) => {
      starts.push({ resume: o?.resume === true });
      if (opts.failFresh && starts.length > 1 && o?.resume !== true) throw new Error("新しい会話で起動できない");
      if (ctl.failNextFresh && o?.resume !== true) {
        ctl.failNextFresh = false;
        throw new Error("新しい会話で起動できない（1 回だけ）");
      }
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
    // スリープの起床（daemon.ts と同じ配線）。res は後で作るので、呼ばれる時に参照する
    onWake: (n, h) => res.armWake(n, h),
    onWakeAbort: (n) => res.disarmWake(n),
  });
  const memoryEvents = createCenterMemoryEvents({ memoryOf: () => memoryDef, log: (m) => void logs.push(m) });
  const res: Resessioner = createResessioner({
    info: (name) => sessions.list().find((x) => x.name === name),
    restartFresh: (name) => sessions.restartFresh(name),
    sleepNow: (name, ref) => sessions.sleep(name, ref ? { handoff: ref } : undefined),
    afterWakeDelivered: (name, id) => sessions.clearSleepHandoff(name, id),
    saveToMemory: (name, h) => memoryEvents.handoff(name, h, 3000),
    readFromMemory: (name, id) => memoryEvents.readHandoff(name, id, 3000),
    secretsOf: () => [mem.url, `Bearer ${mem.token}`],
    core,
    dir: join(dir, "handoffs"),
    log: (m) => void logs.push(m),
    submitDelayMs: 20,
  });
  const startedAt = (): string | null => sessions.list().find((s) => s.name === "pm1")?.startedAt ?? null;
  return {
    core, sessions, res, tracker, remote, logs, starts, published, standIn, startedAt, ctl,
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

test("流れ: 申告 → 引継ぎが memory に保存（file は書かない）→ turn の終わりで新しい会話に再起動（区切りの行）→ center が memory から取り出して最初の入力に本文を渡す", async () => {
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
  assert.ok(text!.includes(HANDOFF), "center が memory から取り出した本文が最初の入力に入る");
  assert.ok(!text!.includes("mcp__memory__handoff"), "session に引かせない");
  // memory に保存できた時は file を書かない（U11 の A）
  await assert.rejects(readFile(join(dir, "handoffs", "pm1.json"), "utf8"), /ENOENT/);
  // 1 回だけ: 印は消え、2 回目の SessionStart では送らない。記録に渡し済みが付く
  assert.equal(r.res.pending("pm1"), false);
  r.hook(hookOf("SessionStart", { source: "startup" }));
  await sleep(80);
  assert.equal(w2.inputs().length, 2);
  assert.equal(r.res.record("pm1"), undefined, "memory に保存した時は記録を積まない");
  assert.ok(r.logs.some((l) => l.includes("リセッションの最初の入力を送った")));
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
  // 渡した後の file は残し、deliveredAt を書く（U14 の A）
  await until(() => r.res.record("pm1")?.deliveredAt !== undefined);
  const after = JSON.parse(await readFile(join(dir, "handoffs", "pm1.json"), "utf8")) as { body: string; deliveredAt?: string };
  assert.equal(after.body, HANDOFF);
  assert.ok(after.deliveredAt);
  await r.close();
});

test("memory に保存した後に memory が読めなくなった時: 取り出せなかった事・理由・置き場（memory 側）を最初の入力に書く。file は読まない。url・token は書かない", async () => {
  const r = await rig();
  await boot(r);
  const got = await r.res.request("pm1", HANDOFF);
  assert.equal(got.stored, "memory");
  mem.setDown(true);
  r.hook(hookOf("Stop"));
  await until(() => launches.length === 2);
  launches[1]!.child.connect("two");
  r.hook(hookOf("SessionStart", { source: "startup" }));
  await until(() => launches[1]!.child.inputs().length === 2);
  const text = launches[1]!.child.inputs()[0]!;
  assert.ok(text.includes("取り出せなかった") && text.includes(got.handoff_id));
  assert.ok(text.includes("agent=pm1") && text.includes(`eventId=${got.handoff_id}`));
  assert.ok(!text.includes("仕掛かり: x"), "本文は渡していない");
  assert.ok(!text.includes(mem.token) && !text.includes(mem.url));
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
    readFromMemory: over.readFromMemory ?? (async () => ({ body: HANDOFF })),
    ...(over.secretsOf ? { secretsOf: over.secretsOf } : {}),
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
  assert.ok(!ok.logs.some((l) => l.includes("file を書けない")), "memory に保存できた時は file に触らない");
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
  assert.ok(u.inputs[0]!.includes("仕掛かり: x") && !u.inputs[0]!.includes("mcp__memory__handoff"));
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

// ---- 保存・取り出し・渡し方（設計 10.2〜10.4。単体） ----

/** 申告 → turn の終わり → 再起動まで進める。 */
async function toRestart(u: ReturnType<typeof unit>, body = HANDOFF, beforeStop?: (id: string) => Promise<void>): Promise<string> {
  const got = await u.res.request("pm1", body);
  await beforeStop?.(got.handoff_id);
  u.state.info = { ...u.state.info!, activity: "idle" } as SessionInfo;
  u.res.onHook("pm1", hookOf("Stop"));
  await until(() => u.restarts() === 1);
  return got.handoff_id;
}
const start = (u: ReturnType<typeof unit>): void => u.res.onHook("pm1", hookOf("SessionStart", { source: "startup" }));
const unitFile = (name = "pm1"): string => join(dir, "unit-handoffs", `${name}.json`);

test("保存: memory に受理されたら file を書かない・記録を積まない。memory が none / 投げる時は本文入りで file に書く", async () => {
  const mem1 = unit();
  await mem1.res.request("pm1", HANDOFF);
  await assert.rejects(readFile(unitFile(), "utf8"), /ENOENT/);
  assert.equal(mem1.res.record("pm1"), undefined);

  const none = unit({ saveToMemory: async () => "none" });
  const g1 = await none.res.request("pm1", HANDOFF);
  assert.equal(g1.stored, "file");
  const f1 = JSON.parse(await readFile(unitFile(), "utf8")) as { id: string; session: string; stored: string; body: string };
  assert.deepEqual([f1.id, f1.session, f1.stored, f1.body], [g1.handoff_id, "pm1", "file", HANDOFF]);
  assert.equal(none.res.record("pm1")?.body, HANDOFF);

  const down = unit({ saveToMemory: async () => { throw new Error("届かない"); } });
  const g2 = await down.res.request("pm1", HANDOFF + "2");
  assert.equal(g2.stored, "file");
  assert.equal((JSON.parse(await readFile(unitFile(), "utf8")) as { body: string }).body, HANDOFF + "2", "同じ session の 2 回目の保存は上書き");
});

test("file の置き場: session ごとに別の <dir>/<session>.json。.tmp は残らない", async () => {
  const { readdir } = await import("node:fs/promises");
  const a = unit({ saveToMemory: async () => "none" });
  await a.res.request("pm1", HANDOFF);
  a.state.info = { ...a.state.info!, name: "pm2" } as SessionInfo;
  await a.res.request("pm2", HANDOFF + "b");
  assert.deepEqual((await readdir(join(dir, "unit-handoffs"))).sort(), ["pm1.json", "pm2.json"]);
});

test("取り出し（memory）: 印に本文を持ち越さず、memory から読んだ本文を渡す。読む時は session 名と id", async () => {
  const calls: string[] = [];
  const u = unit({ readFromMemory: async (s, id) => (calls.push(`${s}|${id}`), { body: "MEMORY の本文" }) });
  const id = await toRestart(u);
  start(u);
  await until(() => u.inputs.length === 2);
  assert.deepEqual(calls, [`pm1|${id}`]);
  assert.ok(u.inputs[0]!.includes("MEMORY の本文"));
  assert.ok(!u.inputs[0]!.includes("仕掛かり: x"), "request 時の本文は使わない");
  assert.ok(u.inputs[0]!.includes(`id=${id}`) && u.inputs[0]!.includes("common の [記録] の順"));
});

test("取り出せなかった（memory）: none / 無い / 投げる / 空。置き場は保存した方（memory）を先に、file は保存していないと書く。file に同じ id があっても読まない（U11 の A）。url・token は理由に出さない", async () => {
  const cases: { name: string; read: () => Promise<"none" | "missing" | { body: string }>; reason: RegExp }[] = [
    { name: "none", read: async () => "none", reason: /設定が無い/ },
    { name: "missing", read: async () => "missing", reason: /該当の引継ぎが無い/ },
    { name: "throw", read: async () => { throw new Error("fetch failed https://mem.example/mcp Bearer SECRET-TOKEN-1"); }, reason: /fetch failed/ },
    { name: "empty", read: async () => ({ body: " " }), reason: /本文が空/ },
  ];
  for (const c of cases) {
    const u = unit({ readFromMemory: c.read, secretsOf: () => ["SECRET-TOKEN-1"] });
    const id = await toRestart(u);
    // 同じ id の file が置き場にあっても、stored = memory の時は読まない
    await mkdir(join(dir, "unit-handoffs"), { recursive: true });
    await writeFile(unitFile(), JSON.stringify({ id, session: "pm1", at: "x", stored: "file", body: "FILE の本文" }));
    start(u);
    await until(() => u.inputs.length === 2);
    const t = u.inputs[0]!;
    assert.ok(t.includes("取り出せなかった"), c.name);
    assert.match(t, c.reason, c.name);
    assert.ok(!t.includes("FILE の本文") && !t.includes("仕掛かり: x") && !t.includes("--- 引継ぎ ---"), `${c.name}: 本文は渡さない`);
    const place = t.slice(t.indexOf("置き場:"));
    assert.ok(place.indexOf("外部記憶（agent=pm1、eventId=") < place.indexOf("file "), `${c.name}: 保存した方を先`);
    assert.ok(place.includes(`${unitFile()} には保存していない`), c.name);
    assert.ok(!t.includes("SECRET-TOKEN-1") && !t.includes("mem.example"), `${c.name}: 秘密を書かない`);
    assert.ok(!t.includes("mcp__memory__handoff"), c.name);
    await rm(join(dir, "unit-handoffs"), { recursive: true, force: true });
  }
});

test("取り出し（file）: file を読む。process 内の本文には頼らない（file の本文を差し替えると差し替えが渡る）。記録の渡し済みは本文を渡した時だけ", async () => {
  const u = unit({ saveToMemory: async () => "none" });
  const id = await toRestart(u, HANDOFF, async () => {
    const f = JSON.parse(await readFile(unitFile(), "utf8")) as Record<string, unknown>;
    await writeFile(unitFile(), JSON.stringify({ ...f, body: "差し替えた本文" }));
  });
  start(u);
  await until(() => u.inputs.length === 2);
  assert.ok(u.inputs[0]!.includes("差し替えた本文") && !u.inputs[0]!.includes("仕掛かり: x"));
  await until(() => u.res.record("pm1")?.deliveredAt !== undefined);
  const after = JSON.parse(await readFile(unitFile(), "utf8")) as { id: string; body: string; deliveredAt?: string };
  assert.equal(after.id, id);
  assert.ok(after.deliveredAt, "file は残し deliveredAt を書く（U14 の A）");
});

test("取り出せなかった（file）: id が違う file・読めない file・本文が無い file は使わない。置き場は file を先、外部記憶は保存していないと書く。deliveredAt は書かない", async () => {
  const variants: { name: string; make: (id: string) => string | null; reason: RegExp }[] = [
    { name: "別の id", make: () => JSON.stringify({ id: "c1:old", body: "古い引継ぎ" }), reason: /id が違う/ },
    { name: "壊れた json", make: () => "{not json", reason: /file を読めない/ },
    { name: "file が無い", make: () => null, reason: /file を読めない/ },
    { name: "本文が無い", make: (id) => JSON.stringify({ id }), reason: /本文が無い/ },
  ];
  for (const v of variants) {
    const u = unit({ saveToMemory: async () => "none" });
    await toRestart(u, HANDOFF, async (id) => {
      const content = v.make(id);
      if (content === null) await rm(unitFile());
      else await writeFile(unitFile(), content);
    });
    start(u);
    await until(() => u.inputs.length === 2);
    const t = u.inputs[0]!;
    assert.match(t, v.reason, v.name);
    assert.ok(t.includes("取り出せなかった") && !t.includes("古い引継ぎ") && !t.includes("仕掛かり: x"), v.name);
    const place = t.slice(t.indexOf("置き場:"));
    assert.ok(place.indexOf(`file ${unitFile()}`) < place.indexOf("外部記憶（agent=pm1、eventId="), v.name);
    assert.ok(place.includes("には保存していない"), v.name);
    await sleep(10);
    assert.equal(u.res.record("pm1")?.deliveredAt, undefined, `${v.name}: 本文を渡していない`);
    await rm(join(dir, "unit-handoffs"), { recursive: true, force: true });
  }
});

test("取り出しは再起動を待たせない。SessionStart の後、取り出しの結果が来てから最初の入力を送る。1 回だけ", async () => {
  let release: (b: { body: string }) => void = () => {};
  const gate = new Promise<{ body: string }>((r) => (release = r));
  const reads: string[] = [];
  const u = unit({ readFromMemory: async (_s, id) => (reads.push(id), gate) });
  await toRestart(u); // 取り出しが終わらなくても restartFresh は完了している
  assert.equal(reads.length, 1, "再起動の直前に取り出しを始める");
  start(u);
  await sleep(40);
  assert.deepEqual(u.inputs, [], "取り出しの結果を待つ");
  release({ body: "遅れて届いた本文" });
  await until(() => u.inputs.length === 2);
  assert.ok(u.inputs[0]!.includes("遅れて届いた本文"));
  start(u);
  await sleep(30);
  assert.equal(u.inputs.length, 2, "2 回目の SessionStart では送らない");
  assert.equal(reads.length, 1, "取り出しは 1 回");
  assert.equal(u.res.pending("pm1"), false);
});

test("取り出しは投げない: 読む口が例外でも最初の入力は送られ、失敗の旨が入る。区切りの行・再起動は妨げられない", async () => {
  const u = unit({ readFromMemory: async () => { throw new Error("接続が詰まった"); } });
  await toRestart(u);
  start(u);
  await until(() => u.inputs.length === 2);
  assert.ok(u.inputs[0]!.includes("取り出せなかった: 接続が詰まった"));
  assert.equal(u.inputs[1], "\r");
  assert.ok(u.logs.some((l) => l.includes("引継ぎを取り出せない")));
});

test("firstInputText: 取り出せた時は本文入りで handoff を引かせる文が無い。取り出せなかった時は 1 行で本文が無い", () => {
  const ok = firstInputText({ id: "c1:x", stored: "memory", session: "s", file: "/d/s.json", result: { ok: true, body: "本文\nA" } });
  assert.ok(ok.includes("引継ぎ（id=c1:x）の本文を渡す") && ok.includes("--- 引継ぎ ---\n本文\nA\n--- ここまで ---"));
  assert.ok(!ok.includes("mcp__memory__handoff") && !ok.includes("自分で"));
  const ng = firstInputText({ id: "c1:x", stored: "file", session: "s", file: "/d/s.json", result: { ok: false, reason: "R" } });
  assert.ok(!ng.includes("\n") && ng.includes("取り出せなかった: R") && ng.includes("本文は渡していない"));
});


// ---- スリープ = 起動しないリセッション（docs/design/sleep-resession.md） ----

const savedFile = async (): Promise<{ name: string; sleeping?: boolean; sleepHandoff?: { id: string; stored: string } }[]> =>
  JSON.parse(await readFile(join(dir, "sessions.json"), "utf8"));
const wakeInputs = (w: FakeWrapper): string[] => w.inputs();
const ASK = "スリープの依頼";

/** 眠らせるところまで通す（turn の終わり → 依頼で引継ぎを頼む → 引継ぎ → Stop で停止）。 */
async function sleepThrough(r: Rig, w: FakeWrapper): Promise<{ id: string; stored: string }> {
  r.hook(hookOf("Stop")); // 作業中は断られるので、turn が終わってから依頼する
  await r.res.requestSleep("pm1");
  await until(() => w.inputs().length === 2);
  r.hook(hookOf("UserPromptSubmit", { prompt: "ask" }));
  const got = await r.res.request("pm1", HANDOFF);
  r.hook(hookOf("Stop", { last_assistant_message: "眠る" }));
  await until(() => r.sessions.list()[0]!.sleeping);
  return { id: got.handoff_id, stored: got.stored };
}

test("T1/T3: requestSleep は受理して即返す（まだ眠らない）。作業中は Stop を待たず断る。引継ぎを頼む 1 行を貼り、引継ぎを受けても Stop までは止めない。Stop で止める（新しい会話は起動しない）。sleeping と sleepHandoff が保存される", async () => {
  const r = await rig();
  const w1 = await boot(r);
  // 作業中（working）は頼まず断る。印は残らない
  await assert.rejects(r.res.requestSleep("pm1"), /作業中は眠らせられない/);
  assert.deepEqual(w1.inputs(), []);
  assert.equal(r.res.pending("pm1"), false);
  r.hook(hookOf("Stop"));
  const q = await r.res.requestSleep("pm1");
  assert.deepEqual({ accepted: q.accepted, sleeping: q.sleeping, pending: q.pending }, { accepted: true, sleeping: false, pending: true });
  // 引継ぎを頼む 1 行（bracketed paste + Enter）
  await until(() => w1.inputs().length === 2);
  assert.ok(w1.inputs()[0]!.includes(ASK) && w1.inputs()[0]!.includes("session_resession"));
  assert.equal(w1.inputs()[1], "\r");
  // 頼んだ間（引継ぎを受ける前）は止めない
  r.hook(hookOf("UserPromptSubmit", { prompt: "ask" }));
  r.hook(hookOf("Stop"));
  await sleep(60);
  assert.equal(w1.stopped(), false);
  assert.equal(r.sessions.list()[0]!.sleeping, false);
  assert.equal(r.res.pending("pm1"), true);
  r.hook(hookOf("UserPromptSubmit", { prompt: "ask" }));
  const got = await r.res.request("pm1", HANDOFF);
  assert.ok(got.restart.includes("眠らせる"), "眠らせる為の返事");
  // tool の呼び出しの後、Stop の前: まだ止めない
  await sleep(60);
  assert.equal(w1.stopped(), false);
  assert.equal(r.sessions.list()[0]!.sleeping, false);
  r.hook(hookOf("Stop", { last_assistant_message: "眠る" }));
  await until(() => r.sessions.list()[0]!.sleeping);
  assert.equal(w1.stopped(), true);
  assert.equal(launches.length, 1, "新しい会話を立ち上げない");
  assert.deepEqual(r.starts, [{ resume: false }], "起動は最初の 1 回だけ（再起動も --continue も無い）");
  const rec = (await savedFile())[0]!;
  assert.equal(rec.sleeping, true);
  assert.deepEqual(rec.sleepHandoff, { id: got.handoff_id, stored: "memory" });
  assert.deepEqual(r.standIn, ["pm1:true"]);
  assert.equal(r.res.pending("pm1"), false);
  assert.ok(r.published.includes("sleep"));
  await r.close();
});

test("T4: 作業中（working・subagent・background）は Stop を待たず断る。待つ印も残さない", async () => {
  const r = await rig();
  const w1 = await boot(r);
  await assert.rejects(r.res.requestSleep("pm1"), /作業中は眠らせられない/);
  r.hook(hookOf("Stop"));
  r.hook(hookOf("SubagentStart", { agent_id: "a1" }));
  assert.ok(r.sessions.list()[0]!.background.subagents > 0, "subagent が動いている");
  await assert.rejects(r.res.requestSleep("pm1"), /作業中は眠らせられない/);
  r.hook(hookOf("Stop"));
  await sleep(40);
  assert.equal(r.res.pending("pm1"), false);
  assert.deepEqual(w1.inputs(), []);
  await r.close();
});

test("T2: 引継ぎは memory に保存する（stored=memory・file は書かない）。届かない時は file（stored=file・本文は file にある）。sleepHandoff の stored もそれに従う", async () => {
  const r = await rig();
  const w1 = await boot(r);
  const ref = await sleepThrough(r, w1);
  assert.equal(ref.stored, "memory");
  const evs = mem.recorded().filter((e) => e.kind === "handoff");
  assert.equal(evs.length, 1);
  assert.equal(evs[0]!.body, HANDOFF);
  await assert.rejects(readFile(join(dir, "handoffs", "pm1.json"), "utf8"), /ENOENT/);
  await r.close();

  mem.setDown(true);
  const r2 = await rig();
  const w2 = await boot(r2);
  const ref2 = await sleepThrough(r2, w2);
  assert.equal(ref2.stored, "file");
  const file = JSON.parse(await readFile(join(dir, "handoffs", "pm1.json"), "utf8")) as { id: string; body: string };
  assert.equal(file.body, HANDOFF);
  assert.equal(file.id, ref2.id);
  assert.deepEqual((await savedFile())[0]!.sleepHandoff, { id: ref2.id, stored: "file" });
  await r2.close();
});

test("T4: 書けない時は眠らせず理由を返す: needs-input・remote 未完了・未返答・動いていない session。印は残らず入力も貼らない", async () => {
  const r = await rig();
  const w1 = await boot(r);
  r.hook(hookOf("PermissionRequest"));
  await assert.rejects(r.res.requestSleep("pm1"), /needs-input/);
  r.hook(hookOf("PostToolUse"));
  r.remote.running = 1;
  await assert.rejects(r.res.requestSleep("pm1"), /未完了の remote/);
  r.remote.running = 0;
  r.remote.waitingReply = 1;
  await assert.rejects(r.res.requestSleep("pm1"), /worker_reply/);
  r.remote.waitingReply = 0;
  assert.equal(r.res.pending("pm1"), false);
  assert.deepEqual(w1.inputs(), []);
  assert.equal(r.sessions.list()[0]!.sleeping, false);
  // 動いていない session
  const r2 = await rig();
  await r2.sessions.create({ name: "pm1", start: false });
  await assert.rejects(r2.res.requestSleep("pm1"), /動いていない/);
  assert.equal(r2.res.pending("pm1"), false);
  await r2.close();
  await r.close();
});

test("T4: 引継ぎの申告の後に利用者の入力が来て会話が進んだ時は止めない（印を戻す）。頼んだ後に Stop で見直して working なら止めない", async () => {
  const r = await rig();
  const w1 = await boot(r);
  r.hook(hookOf("Stop"));
  await r.res.requestSleep("pm1");
  await until(() => w1.inputs().length === 2);
  r.hook(hookOf("UserPromptSubmit", { prompt: "ask" }));
  await r.res.request("pm1", HANDOFF);
  r.hook(hookOf("UserPromptSubmit", { prompt: "やっぱり続けて" }));
  assert.equal(r.res.pending("pm1"), false, "印が戻った");
  r.hook(hookOf("Stop"));
  await sleep(80);
  assert.equal(w1.stopped(), false);
  assert.equal(r.sessions.list()[0]!.sleeping, false);
  await r.close();
});

test("T4: 見直し（Stop の後の check）が通らない時は止めない（Stop の後に remote の指示が走っていた）", async () => {
  const r = await rig();
  const w1 = await boot(r);
  r.hook(hookOf("Stop"));
  await r.res.requestSleep("pm1");
  await until(() => w1.inputs().length === 2);
  r.hook(hookOf("UserPromptSubmit", { prompt: "ask" }));
  await r.res.request("pm1", HANDOFF);
  r.remote.running = 1;
  r.hook(hookOf("Stop"));
  await sleep(80);
  assert.equal(w1.stopped(), false);
  assert.equal(r.res.pending("pm1"), false);
  assert.ok(r.logs.some((l) => l.includes("スリープ見送り")));
  await r.close();
});

test("T5/T9: 起こすと --continue 無しの新しい会話で起動し、SessionStart(startup) の最初の入力に引継ぎの本文が入る（paste → Enter。入力は合計 2 回 = 状況確認の別の入力は無い）。渡した後は sleepHandoff が外れ、区切りの行が積まれる", async () => {
  const r = await rig();
  const w1 = await boot(r);
  const ref = await sleepThrough(r, w1);
  await r.sessions.wake("pm1");
  assert.deepEqual(r.starts.at(-1), { resume: false });
  assert.ok(!launches[1]!.args.includes("--continue"));
  assert.equal(r.res.pending("pm1"), true, "起こす起動の前に印が付く");
  const w2 = launches[1]!.child;
  const evs: string[] = [];
  r.core.subscribe("pm1", undefined, (e) => e.type === "chunk" && evs.push(e.data.toString()))!();
  w2.connect("two");
  await sleep(60);
  assert.deepEqual(wakeInputs(w2), [], "SessionStart を見るまで送らない");
  r.hook(hookOf("SessionStart", { source: "startup" }));
  await until(() => w2.inputs().length === 2);
  const [text, enter] = w2.inputs();
  assert.equal(enter, "\r");
  assert.ok(text!.includes("スリープから起こした") && !text!.includes("リセッションで再起動した"));
  assert.ok(text!.includes(ref.id) && text!.includes(HANDOFF));
  await sleep(120);
  assert.equal(w2.inputs().length, 2, "状況確認の別の入力は送らない");
  assert.equal(r.res.pending("pm1"), false);
  // 渡した後は参照が外れる
  assert.equal((await savedFile())[0]!.sleepHandoff, undefined);
  assert.ok(evs.includes(WAKE_DIVIDER), "区切りの行");
  assert.equal((await savedFile())[0]!.sleeping, undefined);
  await r.close();
});

test("T9: 渡した後の 2 回目の眠り（引継ぎ無し）→ 起こしでは古い引継ぎを渡さない。--continue で元の会話を起こす（T11 の分岐）", async () => {
  const r = await rig();
  const w1 = await boot(r);
  await sleepThrough(r, w1);
  await r.sessions.wake("pm1");
  const w2 = launches[1]!.child;
  w2.connect("two");
  r.hook(hookOf("SessionStart", { source: "startup" }));
  await until(() => w2.inputs().length === 2);
  await sleep(50);
  r.hook(hookOf("Stop"));
  await r.sessions.sleep("pm1");
  assert.equal((await savedFile())[0]!.sleepHandoff, undefined);
  await r.sessions.wake("pm1");
  assert.deepEqual(r.starts.at(-1), { resume: true }, "引継ぎが無い眠りは今までどおり --continue");
  assert.ok(launches[2]!.args.includes("--continue"));
  launches[2]!.child.connect("three");
  r.hook(hookOf("SessionStart", { source: "startup" }));
  await sleep(120);
  assert.deepEqual(launches[2]!.child.inputs(), [], "古い引継ぎを渡さない");
  await r.close();
});

test("T6: 取り出せない時（memory が読めない）は本文を渡さず、事・理由・置き場を書いた 1 行を送る。参照は外す（U5 の B）", async () => {
  const r = await rig();
  const w1 = await boot(r);
  const ref = await sleepThrough(r, w1);
  mem.setDown(true);
  await r.sessions.wake("pm1");
  const w2 = launches[1]!.child;
  w2.connect("two");
  r.hook(hookOf("SessionStart", { source: "startup" }));
  await until(() => w2.inputs().length === 2);
  const text = w2.inputs()[0]!;
  assert.ok(text.includes("スリープから起こした") && text.includes("取り出せなかった") && text.includes(ref.id));
  assert.ok(text.includes("agent=pm1") && text.includes(`eventId=${ref.id}`), "置き場");
  assert.ok(!text.includes("仕掛かり: x") && !text.includes(mem.token) && !text.includes(mem.url));
  assert.ok(!text.includes("\n"));
  for (let i = 0; i < 100 && (await savedFile())[0]!.sleepHandoff !== undefined; i++) await sleep(10);
  assert.equal((await savedFile())[0]!.sleepHandoff, undefined, "取り出せなくても参照は外す");
  await r.close();
});

test("T6: file の保存で id が違う時も、本文を渡さず理由を書く", async () => {
  mem.setDown(true);
  const r = await rig();
  const w1 = await boot(r);
  await sleepThrough(r, w1);
  await writeFile(join(dir, "handoffs", "pm1.json"), JSON.stringify({ id: "古い", body: "古い本文" }));
  await r.sessions.wake("pm1");
  const w2 = launches[1]!.child;
  w2.connect("two");
  r.hook(hookOf("SessionStart", { source: "startup" }));
  await until(() => w2.inputs().length === 2);
  assert.ok(w2.inputs()[0]!.includes("id が違う") && !w2.inputs()[0]!.includes("古い本文"));
  await r.close();
});

test("T7: 起こす起動に失敗したら眠ったままに戻る（sleeping・sleepHandoff が残り、印は外れ、身代わりは戻る）。次の wake でまた引継ぎを渡せる", async () => {
  const r = await rig();
  const w1 = await boot(r);
  const ref = await sleepThrough(r, w1);
  r.ctl.failNextFresh = true;
  await assert.rejects(r.sessions.wake("pm1"), /新しい会話で起動できない/);
  assert.equal(r.sessions.list()[0]!.sleeping, true);
  const rec = (await savedFile())[0]!;
  assert.equal(rec.sleeping, true);
  assert.deepEqual(rec.sleepHandoff, { id: ref.id, stored: "memory" });
  assert.equal(r.res.pending("pm1"), false, "印は外れる");
  assert.deepEqual(r.standIn, ["pm1:true", "pm1:false", "pm1:true"]);
  // もう一度起こすと渡せる
  await r.sessions.wake("pm1");
  const w2 = launches.at(-1)!.child;
  w2.connect("two");
  r.hook(hookOf("SessionStart", { source: "startup" }));
  await until(() => w2.inputs().length === 2);
  assert.ok(w2.inputs()[0]!.includes(HANDOFF));
  await r.close();
});

test("T11: この仕組みの前に眠った session（sleepHandoff 無し）は --continue で起こし、最初の入力は送らない", async () => {
  const r = await rig();
  await boot(r);
  await r.sessions.sleep("pm1");
  assert.equal((await savedFile())[0]!.sleepHandoff, undefined);
  await r.sessions.wake("pm1");
  assert.deepEqual(r.starts.at(-1), { resume: true });
  assert.ok(launches[1]!.args.includes("--continue"));
  assert.equal(r.res.pending("pm1"), false);
  launches[1]!.child.connect("two");
  r.hook(hookOf("SessionStart", { source: "startup" }));
  await sleep(100);
  assert.deepEqual(launches[1]!.child.inputs(), []);
  await r.close();
});

test("requestSleep: 眠っている・config 由来・未定義の session は今までの扱い（何もしない / 拒否）。引継ぎは頼まない", async () => {
  const r = await rig();
  const w1 = await boot(r);
  await r.sessions.sleep("pm1");
  const again = await r.res.requestSleep("pm1");
  assert.deepEqual({ sleeping: again.sleeping, pending: again.pending }, { sleeping: true, pending: false });
  assert.deepEqual(w1.inputs(), []);
  await assert.rejects(r.res.requestSleep("nobody"), /未定義の session/);
  await r.close();
});

test("T13: リセッション（restart の印）は今までどおり再起動し、スリープ（sleep の印）は停止する。同じ session に両方の印は立たない", async () => {
  const r = await rig();
  const w1 = await boot(r);
  await r.res.request("pm1", HANDOFF);
  await assert.rejects(r.res.requestSleep("pm1"), /途中/);
  r.hook(hookOf("Stop"));
  await until(() => launches.length === 2);
  assert.equal(r.sessions.list()[0]!.sleeping, false, "restart は眠らせない");
  assert.equal(w1.stopped(), true);
  await r.close();
});

test("T14: pending は引継ぎを頼んだ間（asking）・起こした後の最初の入力待ち（wake）でも true。終われば false", async () => {
  const r = await rig();
  const w1 = await boot(r);
  assert.equal(r.res.pending("pm1"), false);
  r.hook(hookOf("Stop"));
  await r.res.requestSleep("pm1");
  await until(() => w1.inputs().length === 2);
  assert.equal(r.res.pending("pm1"), true, "asking");
  r.hook(hookOf("UserPromptSubmit", { prompt: "ask" }));
  await r.res.request("pm1", HANDOFF);
  r.hook(hookOf("Stop"));
  await until(() => r.sessions.list()[0]!.sleeping);
  assert.equal(r.res.pending("pm1"), false);
  await r.sessions.wake("pm1");
  assert.equal(r.res.pending("pm1"), true, "wake");
  launches[1]!.child.connect("two");
  r.hook(hookOf("SessionStart", { source: "startup" }));
  await until(() => launches[1]!.child.inputs().length === 2);
  assert.equal(r.res.pending("pm1"), false);
  await r.close();
});

test("firstInputText: kind=wake は先頭の語が「スリープから起こした」。取り出せなかった時の 1 行も同じ", () => {
  const ok = firstInputText({ id: "c1:x", stored: "memory", session: "s", file: "/d/s.json", result: { ok: true, body: "本文" }, kind: "wake" });
  assert.ok(ok.includes("スリープから起こした") && ok.includes("--- 引継ぎ ---\n本文\n--- ここまで ---") && !ok.includes("リセッションで"));
  const ng = firstInputText({ id: "c1:x", stored: "file", session: "s", file: "/d/s.json", result: { ok: false, reason: "R" }, kind: "wake" });
  assert.ok(ng.includes("スリープから起こした") && ng.includes("取り出せなかった: R") && !ng.includes("\n"));
});
