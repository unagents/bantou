import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { toNodeListener, createApp, defineEventHandler, toWebRequest } from "h3";
import type { InboundMessage } from "@unagents/messenger-client";
import { MESSENGER_PROTOCOL } from "@agent-hand/bantou-protocol";
import {
  REPLY_META,
  classifyMeta,
  createDispatcher,
  describeMessage,
  startDaemon,
  type DaemonDeps,
  type DispatchDeps,
} from "../../../../server/utils/bantou/daemon";
import { handleMcpRequest, startMcpListener } from "../../../../server/utils/bantou/mcp";
import { buildServerName } from "../../../../server/utils/bantou/name";
import type { Job } from "../../../../server/utils/bantou/queue";
import { APPROVE_PROMPT, REJECT_PROMPT } from "../../../../server/utils/bantou/prompts";
import { writeState } from "../../../../server/utils/bantou/state";
import type { WorkerRunInput } from "../../../../server/utils/bantou/worker";

const protocolDir = fileURLToPath(new URL("../../../../../protocol/messenger", import.meta.url));
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// -- 純粋関数 ---------------------------------------------------------------------

test("meta の分類: 無し=旧形式、bantou=処理、他 protocol=無視", () => {
  assert.equal(classifyMeta(undefined), "legacy");
  assert.equal(classifyMeta(null), "legacy");
  assert.equal(classifyMeta({ protocol: "bantou", version: "2.0.0" }), "bantou");
  assert.equal(classifyMeta({ protocol: "other", version: "1.0.0" }), "other");
});

test("返信 meta は protocol.json の name / version と一致する", async () => {
  const m = JSON.parse(await readFile(join(protocolDir, "protocol.json"), "utf8")) as { name: string; version: string };
  assert.deepEqual(REPLY_META, { protocol: m.name, version: m.version });
  assert.equal(REPLY_META.version, MESSENGER_PROTOCOL.version);
});

test("describeMessage: prompt・content は先頭 80 文字だけ", () => {
  const long = "x".repeat(200);
  const line = describeMessage({ protocol: "bantou", callType: "invoke", order: "launch", "parent-id": "cap", model: "sonnet", prompt: long, ws: "ws://h" });
  assert.ok(line.includes("parent-id=cap") && line.includes("model=sonnet") && line.includes("ws=ws://h"));
  assert.ok(line.includes(`prompt=${"x".repeat(80)}`) && !line.includes("x".repeat(81)));
  const a = describeMessage({ protocol: "bantou", callType: "reply", order: "answer", "session-id": "s", content: long });
  assert.ok(a.includes("session-id=s") && !a.includes("x".repeat(81)));
});

test("describeMessage: ws の token（?token=...）は log に出ない", () => {
  const line = describeMessage({ protocol: "bantou", callType: "invoke", order: "launch", "parent-id": "cap", model: "sonnet", prompt: "p", ws: "ws://user:pw@center.example:8080/ws?token=SECRET123#frag" });
  assert.ok(!line.includes("SECRET123") && !line.includes("pw@") && !line.includes("frag"), line);
  assert.ok(line.includes("ws=ws://***@center.example:8080/ws?***"), line);
});

test("describeMessage: launch の schema の認証の値と query は log に出ない", () => {
  const schema = { type: "http" as const, url: "http://c:1/mcp/schemas?k=QSECRET", headers: { Authorization: "Bearer HSECRET" } };
  const line = describeMessage({ protocol: "bantou", callType: "invoke", order: "launch", "parent-id": "cap", model: "sonnet", prompt: "p", ws: "ws://h", schema });
  assert.ok(!line.includes("HSECRET") && !line.includes("QSECRET") && !line.includes("Bearer"), line);
  assert.ok(line.includes("schema=http://c:1/mcp/schemas?***"), line);
});

// -- dispatcher -------------------------------------------------------------------

interface DRig {
  jobs: Array<{ input: WorkerRunInput; kind: "launch" | "reply"; settle: () => void }>;
  stops: string[];
  replies: Array<{ to: string; text: string }>;
  d: DispatchDeps;
  ws: string;
  cleanup(): Promise<void>;
}

async function drig(serverVersion = "0.7.0"): Promise<DRig> {
  const ws = await mkdtemp(join(tmpdir(), "bantou-dispatch-test-"));
  const jobs: DRig["jobs"] = [];
  const stops: string[] = [];
  const replies: DRig["replies"] = [];
  const d: DispatchDeps = {
    workspace: ws,
    serverVersion,
    queue: {
      submit: () => {},
      stop: (p) => (stops.push(p), { running: 0, queued: 0 }),
    },
    makeJob: (input, kind, onSettled) => {
      jobs.push({ input, kind, settle: onSettled });
      const job: Job = { kind, parentId: input.parentId, workerId: input.workerId, start: async () => {}, abort() {} };
      return job;
    },
    replyToSender: async (to, text) => {
      replies.push({ to, text });
    },
    log: () => {},
  };
  // queue.submit が makeJob の結果を受けた形にして、submit の回数も見えるようにする
  const submitted: Job[] = [];
  d.queue = { submit: (j) => void submitted.push(j), stop: d.queue.stop };
  return { jobs, stops, replies, d, ws, cleanup: () => rm(ws, { recursive: true, force: true }) };
}

const msg = (body: unknown, over: Partial<Pick<InboundMessage, "meta" | "from_id" | "from_name" | "mode">> = {}) => ({
  text: typeof body === "string" ? body : JSON.stringify(body),
  meta: { protocol: "bantou", version: "2.0.0" },
  from_id: "id-center",
  from_name: "center-name",
  mode: "message" as InboundMessage["mode"],
  ...over,
});

const launchBody = { protocol: "bantou", callType: "invoke", order: "launch", "parent-id": "cap-1", model: "opus[1m]", prompt: "やる", ws: "ws://c/ws" };

test("dispatcher: launch は新しい worker（session-id を自前で作る）の job を作る。返事は無い", async () => {
  const r = await drig();
  try {
    await createDispatcher(r.d).handle(msg(launchBody));
    assert.equal(r.jobs.length, 1);
    const j = r.jobs[0]!;
    assert.equal(j.kind, "launch");
    assert.equal(j.input.mode, "new");
    assert.equal(j.input.parentId, "cap-1");
    assert.equal(j.input.model, "opus[1m]");
    assert.equal(j.input.prompt, "やる");
    assert.equal(j.input.ws, "ws://c/ws");
    assert.match(j.input.workerId, /^w-[0-9a-f]{10}$/);
    assert.equal(j.input.dir, join(r.ws, "workers", j.input.workerId));
    assert.match(j.input.sessionId, /^[0-9a-f-]{36}$/);
    assert.deepEqual(r.replies, []);
    // launch ごとに別の worker
    await createDispatcher(r.d).handle(msg(launchBody));
    assert.notEqual(r.jobs[1]!.input.workerId, j.input.workerId);
  } finally {
    await r.cleanup();
  }
});

test("dispatcher: launch の schema は job の input に渡る（無ければ input に schema が無い）。形が不正な schema の launch は無視", async () => {
  const r = await drig();
  try {
    const schema = { type: "http", url: "http://c:1/mcp/schemas", headers: { Authorization: "Bearer x" } };
    await createDispatcher(r.d).handle(msg({ ...launchBody, schema }));
    assert.deepEqual(r.jobs[0]!.input.schema, schema);
    await createDispatcher(r.d).handle(msg(launchBody));
    assert.equal("schema" in r.jobs[1]!.input, false);
    await createDispatcher(r.d).handle(msg({ ...launchBody, schema: { type: "http", url: "" } }));
    assert.equal(r.jobs.length, 2);
  } finally {
    await r.cleanup();
  }
});

test("dispatcher: launch の model は省略できる（job の input に model が無い = --model を付けない）", async () => {
  const r = await drig();
  try {
    const { model: _omit, ...noModel } = launchBody;
    await createDispatcher(r.d).handle(msg(noModel));
    assert.equal(r.jobs.length, 1);
    assert.equal("model" in r.jobs[0]!.input, false);
    assert.equal(r.jobs[0]!.input.model, undefined);
  } finally {
    await r.cleanup();
  }
});

test("dispatcher: stop は parent-id で queue.stop。返事は無い", async () => {
  const r = await drig();
  try {
    await createDispatcher(r.d).handle(msg({ protocol: "bantou", callType: "invoke", order: "stop", "parent-id": "cap-1" }));
    assert.deepEqual(r.stops, ["cap-1"]);
    assert.deepEqual(r.replies, []);
  } finally {
    await r.cleanup();
  }
});

test("dispatcher: exec・guard に通らない物・他 protocol・ping・非 JSON は無視（何もしない）", async () => {
  const r = await drig();
  try {
    const dsp = createDispatcher(r.d);
    await dsp.handle(msg({ protocol: "bantou", callType: "exec", order: "run" }));
    await dsp.handle(msg({ protocol: "bantou", callType: "exec", order: "launch", "parent-id": "c", model: "m", prompt: "p", ws: "w" }));
    await dsp.handle(msg({ ...launchBody, model: "-bad" }));
    await dsp.handle(msg({ ...launchBody, prompt: "" }));
    await dsp.handle(msg({ ...launchBody, "parent-id": "" }));
    await dsp.handle(msg({ bantou: 1, type: "kick_cap", cap_id: "c", prompt: "p" }));
    await dsp.handle(msg({ bantou: 1, type: "status" }));
    await dsp.handle(msg("hello"));
    await dsp.handle(msg(launchBody, { meta: { protocol: "other", version: "1.0.0" } }));
    await dsp.handle(msg(launchBody, { mode: "ping" }));
    assert.deepEqual(r.jobs, []);
    assert.deepEqual(r.stops, []);
    assert.deepEqual(r.replies, []);
  } finally {
    await r.cleanup();
  }
});

async function seedWorker(ws: string, id: string, session: string): Promise<void> {
  await writeState(join(ws, "workers", id), {
    worker_id: id,
    session_id: session,
    parent_id: "cap-1",
    ws: "ws://c/ws",
    model: "sonnet",
    last_started_at: null,
    last_finished_at: null,
  });
}

test("dispatcher: reply（answer / approve / reject）は session-id の worker を --resume で起こし直す job。prompt は answer=content、approve / reject=固定", async () => {
  const r = await drig();
  try {
    await seedWorker(r.ws, "w-a", "sess-a");
    await seedWorker(r.ws, "w-b", "sess-b");
    await seedWorker(r.ws, "w-c", "sess-c");
    const dsp = createDispatcher(r.d);
    const reply = (order: string, sid: string, content?: string) =>
      msg({ protocol: "bantou", callType: "reply", order, "session-id": sid, ...(content !== undefined ? { content } : {}) });
    await dsp.handle(reply("answer", "sess-a", "A案で行く"));
    await dsp.handle(reply("approve", "sess-b"));
    await dsp.handle(reply("reject", "sess-c"));
    assert.deepEqual(
      r.jobs.map((j) => [j.kind, j.input.mode, j.input.workerId, j.input.sessionId, j.input.prompt, j.input.parentId, j.input.ws, j.input.model]),
      [
        ["reply", "resume", "w-a", "sess-a", "A案で行く", "cap-1", "ws://c/ws", "sonnet"],
        ["reply", "resume", "w-b", "sess-b", APPROVE_PROMPT, "cap-1", "ws://c/ws", "sonnet"],
        ["reply", "resume", "w-c", "sess-c", REJECT_PROMPT, "cap-1", "ws://c/ws", "sonnet"],
      ],
    );
    assert.equal(r.jobs[0]!.input.dir, join(r.ws, "workers", "w-a"));
  } finally {
    await r.cleanup();
  }
});

test("dispatcher: reply の session-id が無ければログして無視。ある session の reply は queue に入る", async () => {
  const r = await drig();
  try {
    await seedWorker(r.ws, "w-a", "sess-a");
    const dsp = createDispatcher(r.d);
    const ans = (sid: string) => msg({ protocol: "bantou", callType: "reply", order: "answer", "session-id": sid, content: "x" });
    await dsp.handle(ans("nope"));
    assert.equal(r.jobs.length, 0);
    await dsp.handle(ans("sess-a"));
    assert.equal(r.jobs.length, 1);
  } finally {
    await r.cleanup();
  }
});

test("dispatcher: server-info は版だけを、送ってきた名前（from_name）に返す。版が x.y.z でなければ答えない", async () => {
  const r = await drig("0.7.3");
  try {
    await createDispatcher(r.d).handle(msg({ protocol: "bantou", callType: "status", order: "server-info" }));
    assert.equal(r.replies.length, 1);
    assert.equal(r.replies[0]!.to, "center-name");
    assert.deepEqual(JSON.parse(r.replies[0]!.text), { protocol: "bantou", callType: "status", order: "server-info", version: "0.7.3" });
    // 名前が無い送り手には id
    await createDispatcher(r.d).handle(msg({ protocol: "bantou", callType: "status", order: "server-info" }, { from_name: "" }));
    assert.equal(r.replies[1]!.to, "id-center");
    // server-info の答え（version 付き）は center → server の指示ではない
    await createDispatcher(r.d).handle(msg({ protocol: "bantou", callType: "status", order: "server-info", version: "1.2.3" }));
    assert.equal(r.replies.length, 2);
  } finally {
    await r.cleanup();
  }
  const u = await drig("unknown");
  try {
    await createDispatcher(u.d).handle(msg({ protocol: "bantou", callType: "status", order: "server-info" }));
    assert.deepEqual(u.replies, []);
  } finally {
    await u.cleanup();
  }
});

// -- 実 broker・実 client での通し -----------------------------------------------------

async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => resolve(p));
    });
  });
}

interface Got {
  from_name: string;
  text: string;
  meta: { protocol: string; version: string } | null;
}

interface Peer {
  got: Got[];
  send(to: string, text: string, meta?: { protocol: string; version: string }): void;
  stop(): Promise<void>;
}

/** 別 process の peer（test/fixtures/peer.mjs）。broker は 1 process につき 1 peer しか持てない。 */
async function startPeer(brokerUrl: string, name: string): Promise<Peer> {
  const script = fileURLToPath(new URL("../../../fixtures/peer.mjs", import.meta.url));
  const child = spawn(process.execPath, [script, brokerUrl, name], { stdio: ["pipe", "pipe", "inherit"], cwd: fileURLToPath(new URL("../../../..", import.meta.url)) });
  const got: Got[] = [];
  let ready!: () => void;
  const readyP = new Promise<void>((r) => (ready = r));
  createInterface({ input: child.stdout }).on("line", (line) => {
    const v = JSON.parse(line) as Got & { ready?: boolean };
    if (v.ready) ready();
    else got.push(v);
  });
  await Promise.race([readyP, new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`peer が起動しない: ${name}`)), 20_000))]);
  return {
    got,
    send: (to, text, meta) => void child.stdin.write(JSON.stringify({ to, text, meta: meta ?? null }) + "\n"),
    stop: () =>
      new Promise<void>((r) => {
        child.once("exit", () => r());
        child.stdin.end();
        setTimeout(() => child.kill("SIGKILL"), 3000).unref();
      }),
  };
}

const FAKE_CLAUDE = `#!/usr/bin/env node
const fs = require("node:fs");
const argv = process.argv.slice(2);
const cut = argv.indexOf("--");
const prompt = argv.slice(cut + 1).join(" ");
const flag = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
const sessionId = flag("--session-id") ?? flag("--resume");
fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ argv: argv.slice(0, cut), prompt, sessionId, cwd: process.cwd(), pid: process.pid, tmpdir: process.env.TMPDIR }) + "\\n");
process.stdout.write(JSON.stringify({ type: "system" }) + "\\n");
const result = (so) => process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "", session_id: sessionId, structured_output: so }) + "\\n");
if (prompt.includes("SLEEP")) { setTimeout(() => {}, 60000); }
else if (prompt.includes("ASK")) result({ lastType: "message", status: "ask", content: "どちら？" });
else if (prompt.includes("BROKEN")) result({ lastType: "report", status: "ask", content: "x" });
else result({ lastType: "report", status: "success", content: "done: " + prompt });
`;

test("daemon 通し: launch → ask（message）→ answer → success（report）、server-info、stop、名前", { timeout: 120_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "bantou-daemon-e2e-"));
  const brokerPort = await freePort();
  const saved = { ...process.env };
  process.env.AGENT_MESSENGER_HOST = "127.0.0.1";
  process.env.AGENT_MESSENGER_PORT = String(brokerPort);
  process.env.AGENT_MESSENGER_DISCOVERY = "off";
  const peers: Peer[] = [];
  let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined;
  try {
    const ws = join(dir, "ws");
    await mkdir(ws, { recursive: true });
    const fake = join(dir, "fake-claude");
    await writeFile(fake, FAKE_CLAUDE);
    await chmod(fake, 0o755);
    const fakeLog = join(dir, "fake.log");
    await writeFile(fakeLog, "");
    const configPath = join(dir, "config.json");
    await writeFile(
      configPath,
      JSON.stringify({
        workspace: ws,
        broker: { port: brokerPort, bind: "127.0.0.1", discovery: "off" },
        mcp: { port: 0, bind: "127.0.0.1" },
        session: { claude: fake, maxParallel: 2, env: { FAKE_LOG: fakeLog } },
      }),
    );
    const app = createApp().use("/mcp", defineEventHandler((e) => handleMcpRequest(toWebRequest(e))));
    daemon = await startDaemon(configPath, {
      protocolDir,
      serverVersion: "0.7.1",
      namePrefix: "e2e",
      machineId: () => "machine-e2e",
      cpus: () => 4,
      loadavg1: () => 0,
      startMcp: (o) => startMcpListener(toNodeListener(app), o),
    });
    const name = buildServerName("machine-e2e", "e2e");
    assert.equal(daemon.name, name);
    assert.match(name, /^e2e-bantou-server-[0-9a-f]{10}$/);
    // supervisor への合図
    assert.ok((await stat(join(ws, "server.ready"))).isFile());

    const url = `http://127.0.0.1:${brokerPort}`;
    const center = await startPeer(url, "bantou-center-e2e");
    peers.push(center);
    const cap = await startPeer(url, "cap-e2e");
    peers.push(cap);
    const capGot = cap.got;
    const centerGot = center.got;
    const waitFor = async <T>(f: () => T | undefined, what: string, ms = 20_000): Promise<T> => {
      const end = Date.now() + ms;
      for (;;) {
        const v = f();
        if (v !== undefined) return v;
        if (Date.now() > end) throw new Error(`待ちが切れた: ${what}`);
        await sleep(50);
      }
    };
    const send = (body: unknown) => center.send(name, JSON.stringify(body), { protocol: "bantou", version: MESSENGER_PROTOCOL.version });
    const base = { protocol: "bantou" };

    // 1. launch（ASK）→ cap に message（ask、session-id 付き、meta 無し）
    await send({ ...base, callType: "invoke", order: "launch", "parent-id": "cap-e2e", model: "sonnet", prompt: "ASK please", ws: "ws://127.0.0.1:9/none" });
    const ask = await waitFor(() => capGot[0], "ask");
    assert.ok(ask.meta === null || ask.meta === undefined, "cap への message に meta.protocol は付けない");
    const askBody = JSON.parse(ask.text) as Record<string, unknown>;
    assert.deepEqual(Object.keys(askBody).sort(), ["content", "session-id", "status"]);
    assert.equal(askBody.status, "ask");
    assert.equal(askBody.content, "どちら？");
    const sessionId = askBody["session-id"] as string;
    assert.match(sessionId, /^[0-9a-f-]{36}$/);
    // launch に返事は無い
    assert.equal(centerGot.length, 0);

    // 2. answer → 同じ session で --resume、cap に report（success、session-id 無し）
    await send({ ...base, callType: "reply", order: "answer", "session-id": sessionId, content: "A案で" });
    const done = await waitFor(() => capGot[1], "report");
    assert.deepEqual(JSON.parse(done.text), { status: "success", content: "done: A案で" });
    const calls = (await readFile(fakeLog, "utf8")).trim().split("\n").map((l) => JSON.parse(l) as { argv: string[]; prompt: string; sessionId: string; cwd: string; tmpdir: string });
    assert.equal(calls.length, 2);
    assert.ok(calls[0]!.argv.includes("--session-id") && calls[0]!.argv.includes("--json-schema") && calls[0]!.argv.includes("--model"));
    assert.ok(calls[1]!.argv.includes("--resume") && calls[1]!.argv.includes("--json-schema"));
    assert.equal(calls[1]!.sessionId, sessionId);
    assert.equal(calls[1]!.cwd, calls[0]!.cwd, "同じ cwd で起こし直す");
    assert.ok(calls[0]!.cwd.startsWith(join(ws, "workers")));
    assert.equal(calls[0]!.tmpdir, join(calls[0]!.cwd, "tmp"));
    // 道具の許可は bash だけ（report 道具は無い）
    const from = calls[0]!.argv.indexOf("--allowedTools") + 1;
    const allowed = calls[0]!.argv.slice(from, calls[0]!.argv.findIndex((a, i) => i >= from && a.startsWith("--")));
    assert.ok(allowed.includes("mcp__bantou__bash"));
    assert.ok(!allowed.some((t) => t.includes("report") || t.includes("worker_")));

    // 3. server-info → 送ってきた名前に版だけ返る（meta 付き）
    await send({ ...base, callType: "status", order: "server-info" });
    const info = await waitFor(() => center.got[0], "server-info");
    assert.deepEqual(JSON.parse(info.text), { protocol: "bantou", callType: "status", order: "server-info", version: "0.7.1" });
    assert.equal(info.meta?.protocol, "bantou");
    assert.equal(info.from_name, name);

    // 4. exec・知らない形・別 protocol は無視（何も起きない）
    const before = capGot.length;
    await send({ ...base, callType: "exec", order: "run" });
    await send({ ...base, callType: "exec", order: "launch", "parent-id": "cap-e2e", model: "sonnet", prompt: "exec", ws: "ws://h" });
    center.send(name, JSON.stringify({ protocol: "bantou", callType: "invoke", order: "launch", "parent-id": "cap-e2e", model: "sonnet", prompt: "other", ws: "ws://h" }), { protocol: "other", version: "1.0.0" });
    await sleep(1500);
    assert.equal(capGot.length, before);
    assert.equal((await readFile(fakeLog, "utf8")).trim().split("\n").length, 2, "無視した指示では claude を起こさない");

    // 5. 最後の出力の組が不正なら server が failed を付ける
    await send({ ...base, callType: "invoke", order: "launch", "parent-id": "cap-e2e", model: "sonnet", prompt: "BROKEN", ws: "ws://127.0.0.1:9/none" });
    const broken = await waitFor(() => capGot[2], "failed");
    assert.equal((JSON.parse(broken.text) as { status: string }).status, "failed");

    // 6. stop: 動いている worker を止め、結果は cap へ送らない
    await send({ ...base, callType: "invoke", order: "launch", "parent-id": "cap-e2e", model: "sonnet", prompt: "SLEEP", ws: "ws://127.0.0.1:9/none" });
    const sleeper = await waitFor(() => {
      const ls = readFileSync(fakeLog, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { prompt: string; pid: number });
      return ls.find((l) => l.prompt === "SLEEP");
    }, "SLEEP worker の起動");
    await send({ ...base, callType: "invoke", order: "stop", "parent-id": "cap-e2e" });
    await waitFor(() => {
      try {
        process.kill(sleeper.pid, 0);
        return undefined;
      } catch {
        return true;
      }
    }, "SLEEP worker の停止", 15_000);
    await sleep(800);
    assert.equal(capGot.length, 3, "stop で止めた worker の結果は送らない");
  } finally {
    for (const p of peers) await p.stop();
    await daemon?.stop();
    process.env = saved;
    await rm(dir, { recursive: true, force: true });
  }
});

test("daemon: 機械の ID を読めなければ起動しない（broker も立てない）", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bantou-daemon-noid-"));
  try {
    const configPath = join(dir, "config.json");
    await writeFile(configPath, JSON.stringify({ workspace: join(dir, "ws"), broker: { port: 0, bind: "127.0.0.1", discovery: "off" }, mcp: { port: 0, bind: "127.0.0.1" } }));
    await assert.rejects(
      startDaemon(configPath, {
        machineId: () => {
          throw new Error("機械の ID を読めない（テスト）");
        },
        startMcp: async () => {
          throw new Error("呼ばれない");
        },
      }),
      /機械の ID を読めない/,
    );
    await assert.rejects(stat(join(dir, "ws", "broker.json")));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

/** agent-messenger の client の差し替え。connect が connectError を投げれば、同名の登録で error が返った時の形。 */
function fakeClientFactory(opts: { connectError?: Error }): { create: NonNullable<DaemonDeps["createClient"]>; names: string[]; closed: () => boolean } {
  const names: string[] = [];
  let closed = false;
  const create = ((o: { name?: string }) => {
    names.push(o.name ?? "");
    return {
      peer: { id: "fake-id" },
      onMessage: () => {},
      connect: async () => {
        if (opts.connectError) throw opts.connectError;
      },
      setProtocol: async () => ({ name: "bantou", version: "2.0.0", hash: "h" }),
      unsetProtocol: async () => {},
      send: async () => {},
      close: async () => {
        closed = true;
      },
    };
  }) as unknown as NonNullable<DaemonDeps["createClient"]>;
  return { create, names, closed: () => closed };
}

async function daemonConfig(dir: string, extra: Record<string, unknown> = {}): Promise<string> {
  const configPath = join(dir, "config.json");
  await writeFile(
    configPath,
    JSON.stringify({ workspace: join(dir, "ws"), broker: { port: 0, bind: "127.0.0.1", discovery: "off" }, mcp: { port: 0, bind: "127.0.0.1" }, ...extra }),
  );
  return configPath;
}

const stubMcp: DaemonDeps["startMcp"] = async () => ({ port: 1, close: async () => {} });

test("daemon: 同じ名前の登録で error が返ったら起動しない（別の名前にしない・常駐しない）", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bantou-daemon-dup-"));
  try {
    const f = fakeClientFactory({ connectError: new Error("name already registered (テスト)") });
    await assert.rejects(
      startDaemon(await daemonConfig(dir), { machineId: () => "m", startMcp: stubMcp, createClient: f.create }),
      /name already registered/,
    );
    assert.equal(f.names.length, 1, "名前を変えて作り直さない");
    assert.ok(f.closed(), "client を閉じる");
    await assert.rejects(stat(join(dir, "ws", "server.ready")), "ready の合図は書かない");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("daemon: name-prefix は起動 option（deps.namePrefix）が設定 file より優先、どちらも無ければ prefix 無し", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bantou-daemon-prefix-"));
  const key = buildServerName("m", undefined);
  try {
    const run = async (extra: Record<string, unknown>, namePrefix: string | undefined): Promise<string> => {
      const f = fakeClientFactory({});
      const d = await startDaemon(await daemonConfig(dir, extra), { machineId: () => "m", startMcp: stubMcp, createClient: f.create, ...(namePrefix !== undefined ? { namePrefix } : {}) });
      try {
        assert.deepEqual(f.names, [d.name]);
        return d.name;
      } finally {
        await d.stop();
      }
    };
    assert.equal(await run({ namePrefix: "cfg" }, "opt"), `opt-${key}`);
    assert.equal(await run({ namePrefix: "cfg" }, undefined), `cfg-${key}`);
    assert.equal(await run({}, undefined), key);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("daemon 自己更新: 新しい版を見て新しい launch を取り出さず、動いている worker の終了を待ち、queue の待ちを file に持ち、再起動後の daemon が続ける", { timeout: 60_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "bantou-daemon-selfupdate-"));
  const origLog = console.log;
  try {
    const logs: string[] = [];
    console.log = (m?: unknown) => {
      logs.push(String(m));
    };
    const handlers: Array<(m: unknown) => void> = [];
    const clientFor = ((): NonNullable<DaemonDeps["createClient"]> =>
      (() => ({
        peer: { id: "fake-id" },
        onMessage: (h: (m: unknown) => void) => {
          handlers.push(h);
        },
        connect: async () => {},
        setProtocol: async () => ({ name: "bantou", version: "2.0.0", hash: "h" }),
        unsetProtocol: async () => {},
        send: async () => {},
        close: async () => {},
      })) as unknown as NonNullable<DaemonDeps["createClient"]>)();
    const fail = { ok: false as const, sessionMissing: false, timedOut: false, detail: "x", durationMs: 1 };
    const prompts1: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const runner1 = {
      run: async (o: { prompt: string }) => {
        prompts1.push(o.prompt);
        await gate;
        return fail;
      },
    };
    const exits: string[] = [];
    const configPath = await daemonConfig(dir, { session: { maxParallel: 1 }, update: { checkIntervalMs: 1000, maxWaitMs: 60_000 } });
    const d1 = await startDaemon(configPath, {
      machineId: () => "m",
      startMcp: stubMcp,
      createClient: clientFor,
      serverVersion: "0.7.0",
      runner: runner1 as unknown as DaemonDeps["runner"],
      loadavg1: () => 0,
      fetchLatest: async () => "0.8.0",
      requestExit: (r) => exits.push(r),
    });
    const send = (h: (m: unknown) => void, prompt: string): void =>
      h({
        text: JSON.stringify({ protocol: "bantou", callType: "invoke", order: "launch", "parent-id": "cap-1", prompt, ws: "ws://h:7910/ws/worker?token=SECRET" }),
        meta: { protocol: "bantou", version: "2.0.0" },
        from_id: "c1",
        from_name: "center",
      });
    send(handlers[0]!, "A");
    for (let i = 0; i < 200 && prompts1.length === 0; i++) await sleep(50);
    assert.deepEqual(prompts1, ["A"]);
    // 更新の確認は 1 間隔（1 秒）の後。待ちに入った後に来た launch は取り出されない
    while (!logs.some((l) => l.includes("待っている（worker 1）"))) await sleep(50);
    send(handlers[0]!, "B");
    await sleep(150);
    assert.deepEqual(prompts1, ["A"]);
    assert.deepEqual(exits, []);
    release();
    while (exits.length === 0) await sleep(50);
    // 入れ替えのための終了中に届いた launch も捨てず、file に持つ
    const stopping = d1.stop();
    send(handlers[0]!, "C");
    await stopping;
    console.log = origLog;

    assert.deepEqual(prompts1, ["A"]);
    assert.deepEqual(JSON.parse(await readFile(join(dir, "ws", "update.json"), "utf8")), { state: "restart", to: "0.8.0", spec: "bantou@0.8.0" });
    assert.ok(logs.some((l) => l.includes("版 0.8.0 を見つけた")));
    assert.ok(logs.some((l) => l.includes("入れ替える")));
    assert.equal(logs.some((l) => l.includes("SECRET")), false, "ws の token は log に出ない");

    // 再起動後の daemon が、file の待ちを続ける（file は消える）
    const prompts2: string[] = [];
    const runner2 = {
      run: async (o: { prompt: string }) => {
        prompts2.push(o.prompt);
        return fail;
      },
    };
    const d2 = await startDaemon(configPath, { machineId: () => "m", startMcp: stubMcp, createClient: clientFor, serverVersion: "0.8.0", runner: runner2 as unknown as DaemonDeps["runner"], loadavg1: () => 0 });
    while (prompts2.length < 2) await sleep(50);
    assert.deepEqual(prompts2, ["B", "C"]);
    await assert.rejects(stat(join(dir, "ws", "pending-jobs.json")));
    await d2.stop();
  } finally {
    console.log = origLog;
    await rm(dir, { recursive: true, force: true });
  }
});

test("daemon 自己更新: 待ちの途中で更新以外の停止が来たら、worker が終わっても入れ替えに進まない（update.json を書かず、終了も頼まない）", { timeout: 60_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "bantou-daemon-selfupdate-stop-"));
  const origLog = console.log;
  try {
    const logs: string[] = [];
    console.log = (m?: unknown) => {
      logs.push(String(m));
    };
    const handlers: Array<(m: unknown) => void> = [];
    const create = (() => ({
      peer: { id: "fake-id" },
      onMessage: (h: (m: unknown) => void) => {
        handlers.push(h);
      },
      connect: async () => {},
      setProtocol: async () => ({ name: "bantou", version: "2.0.0", hash: "h" }),
      unsetProtocol: async () => {},
      send: async () => {},
      close: async () => {},
    })) as unknown as NonNullable<DaemonDeps["createClient"]>;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const runner = { run: async () => (await gate, { ok: false as const, sessionMissing: false, timedOut: false, detail: "x", durationMs: 1 }) };
    const exits: string[] = [];
    const configPath = await daemonConfig(dir, { update: { checkIntervalMs: 1000, maxWaitMs: 60_000 } });
    const d = await startDaemon(configPath, {
      machineId: () => "m",
      startMcp: stubMcp,
      createClient: create,
      serverVersion: "0.7.0",
      runner: runner as unknown as DaemonDeps["runner"],
      loadavg1: () => 0,
      fetchLatest: async () => "0.8.0",
      requestExit: (r) => exits.push(r),
    });
    handlers[0]!({
      text: JSON.stringify({ protocol: "bantou", callType: "invoke", order: "launch", "parent-id": "cap-1", prompt: "A", ws: "ws://h:7910/ws/worker" }),
      meta: { protocol: "bantou", version: "2.0.0" },
      from_id: "c1",
      from_name: "center",
    });
    while (!logs.some((l) => l.includes("待っている（worker 1）"))) await sleep(50);
    const stopping = d.stop();
    release();
    await stopping;
    await sleep(300);
    console.log = origLog;
    assert.deepEqual(exits, []);
    assert.equal(logs.some((l) => l.includes("入れ替える:")), false);
    await assert.rejects(stat(join(dir, "ws", "update.json")));
  } finally {
    console.log = origLog;
    await rm(dir, { recursive: true, force: true });
  }
});
