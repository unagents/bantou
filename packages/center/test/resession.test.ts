/**
 * リセッション（docs/design/resession.md）。偽の claude（pty wrapper の偽物）・本物の supervisor / SessionManager / core / Resessioner /
 * 外部記憶への書き込み・偽の memory で、申告 → 引継ぎの保存 → 再起動 → 引継ぎを引いて続く、を通す。
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
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
import { createResessioner, RESESSION_DIVIDER, type Resessioner } from "../src/resession.js";
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
  /** 身代わり peer の置き外し（onSleepChange）の履歴。 */
  standIn: string[];
  /** hook を center が受ける順（activity → resession）で流す。 */
  hook: (payload: Record<string, unknown>) => void;
  startedAt: () => string | null;
  close: () => Promise<void>;
}

async function rig(opts: { withMemory?: boolean } = {}): Promise<Rig> {
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
  const tracker = createSessionActivityTracker();
  const standIn: string[] = [];
  const remote = { running: 0, waitingReply: 0 };
  const sessions = createSessionManager({
    config: cfg,
    supervisor: sup,
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
    core, sessions, res, tracker, remote, logs, standIn, startedAt,
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
