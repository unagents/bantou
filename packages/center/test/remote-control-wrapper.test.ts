import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { afterEach, beforeEach, test } from "node:test";
import { parseConfig, type Config, type ProjectConfig } from "../src/config.js";
import { createCore, type CoreEvent } from "../src/core.js";
import { createRemoteControlSupervisor, type ChildLike, type SpawnImpl } from "../src/remote-control.js";
import { createSessionTokens } from "../src/session-auth.js";
import { buildWrapperArgs, findSessionUrl, mcpConfigJson, parseWrapperLine, resolveWrapperPath, windowConnected } from "../src/wrapper.js";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
async function until(fn: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error("until: タイムアウト");
    await sleep(10);
  }
}

/** wrapper の偽物。center から来た行（stdin）を溜め、stdout へ wrapper のメッセージを流す。 */
class FakeWrapper extends EventEmitter implements ChildLike {
  pid: number | undefined = 2000 + Math.floor(Math.random() * 1000);
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
        // stop を受けたら子（claude）を止めて exit メッセージを返し、wrapper も終わる
        if (m.t === "stop") setImmediate(() => this.finish(143, null));
      }
      cb();
    },
  });
  signals: string[] = [];
  kill(sig: NodeJS.Signals | number = "SIGTERM"): boolean {
    this.signals.push(String(sig));
    return true;
  }
  say(msg: Record<string, unknown>): void {
    this.stdout.write(`${JSON.stringify(msg)}\n`);
  }
  text(data: string): void {
    this.say({ t: "text", data });
  }
  out(data: string): void {
    this.say({ t: "output", data: Buffer.from(data).toString("base64") });
  }
  /** claude の終了を伝え（exit メッセージ）、wrapper も終わる。 */
  finish(code: number | null, signal: string | null): void {
    this.say({ t: "exit", code, signal });
    this.rawExit(0);
  }
  /** exit メッセージ無しで wrapper が落ちる。 */
  rawExit(code: number): void {
    this.emit("exit", code, null);
    this.stdout.end();
    this.stderr.end();
    setImmediate(() => this.emit("close", code, null));
  }
  inputs(): string[] {
    return this.lines.filter((l) => l.t === "input").map((l) => Buffer.from(l.data as string, "base64").toString());
  }
}

let dir: string;
let cfg: Config;
let launches: { cmd: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv; child: FakeWrapper }[];
let spawnImpl: SpawnImpl;
const project: ProjectConfig = { name: "pm1", path: "/tmp/pm1", spawn: "same-dir", permissionMode: "plan", autostart: false };

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "center-rcw-"));
  cfg = parseConfig(
    { remoteControl: { claude: "fake-claude", restartDelayMs: 30, maxRestarts: 2, stopGraceMs: 200 }, logDir: join(dir, "logs") },
    join(dir, "c.json"),
  );
  launches = [];
  spawnImpl = (cmd, args, o) => {
    const child = new FakeWrapper();
    launches.push({ cmd, args, cwd: o.cwd, env: o.env, child });
    return child;
  };
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function make(opts: { mcpUrl?: string | null } = {}) {
  const core = createCore();
  const tokens = createSessionTokens();
  const url = opts.mcpUrl === undefined ? "http://127.0.0.1:4567/mcp/session" : opts.mcpUrl;
  const sup = createRemoteControlSupervisor({
    config: cfg,
    log: () => {},
    spawnImpl,
    wrapper: { core, tokens, path: "/fake/bantou-pty-wrapper", mcpUrl: () => url },
  });
  sup.add(project, { wrapper: true });
  return { sup, core, tokens };
}

const chunks = (core: ReturnType<typeof createCore>, name: string): string[] => {
  const out: string[] = [];
  const evs: CoreEvent[] = [];
  core.subscribe(name, undefined, (e) => evs.push(e))!();
  for (const e of evs) if (e.type === "chunk") out.push(`${e.id}:${e.data.toString()}`);
  return out;
};

test("wrapper 起動: wrapper -- claude --remote-control の引数、env の token、--mcp-config は JSON 文字列で token は ${VAR}", async () => {
  const { sup, tokens } = make();
  await sup.start("pm1");
  assert.equal(launches.length, 1);
  const l = launches[0];
  assert.equal(l.cmd, "/fake/bantou-pty-wrapper");
  assert.equal(l.cwd, "/tmp/pm1");
  assert.deepEqual(l.args.slice(0, 6), ["--cols", "120", "--rows", "40", "--", "fake-claude"]);
  assert.deepEqual(l.args.slice(6, 10), ["--remote-control", "pm1", "--permission-mode", "plan"]);
  assert.equal(l.args[10], "--mcp-config");
  assert.equal(l.args.length, 12); // 初回は --continue 無し
  const json = JSON.parse(l.args[11]) as { mcpServers: { bantou: Record<string, unknown> } };
  assert.deepEqual(json.mcpServers.bantou, {
    type: "http",
    url: "http://127.0.0.1:4567/mcp/session",
    headers: { Authorization: "Bearer ${BANTOU_SESSION_TOKEN}", "X-Bantou-Session": "pm1" },
  });
  const token = l.env.BANTOU_SESSION_TOKEN!;
  assert.ok(token && token.length >= 12);
  assert.ok(!l.args.join(" ").includes(token)); // 引数に平文で残さない
  assert.equal(tokens.verify("pm1", token), true);
  assert.equal(l.env.ANTHROPIC_API_KEY, undefined);
  await sup.shutdown();
});

test("http 窓口が無い（mcpUrl が null）時は --mcp-config を付けない", async () => {
  const { sup } = make({ mcpUrl: null });
  await sup.start("pm1");
  assert.ok(!launches[0].args.includes("--mcp-config"));
  await sup.shutdown();
});

test("output は core に積まれ、text が URL の途中で分かれても窓で照合して connected になる", async () => {
  const { sup, core } = make();
  await sup.start("pm1");
  const w = launches[0].child;
  w.out("\x1b[2Jhello");
  w.out(" world");
  w.text("/rc connecting…\n");
  await until(() => chunks(core, "pm1").length === 2);
  assert.equal(sup.status("pm1").state, "starting");
  // カーソル移動で単語が割れた表示 + URL が 2 つの text に分割
  w.text("/remote-control is active · Continue h");
  w.text("re, on your phone, or at https://claude.ai/code/ses");
  await sleep(30);
  assert.equal(sup.status("pm1").sessionUrl, null); // 途中までの URL は採らない
  w.text("sion_01AbC-xyz\n");
  await until(() => sup.status("pm1").sessionUrl !== null);
  assert.equal(sup.status("pm1").sessionUrl, "https://claude.ai/code/session_01AbC-xyz");
  assert.equal(sup.status("pm1").state, "connected");
  // output は生バイトのまま、ID 付きで積まれる
  assert.deepEqual(chunks(core, "pm1"), ["1:\x1b[2Jhello", "2: world"]);
  await sup.shutdown();
});

test("状態行だけ（URL なし）でも /remote-control is active で connected。割れた語句には依存しない", async () => {
  const { sup } = make();
  await sup.start("pm1");
  const w = launches[0].child;
  w.text("/remote-control is act");
  await sleep(30);
  assert.equal(sup.status("pm1").state, "starting");
  w.text("ive · foo");
  await until(() => sup.status("pm1").state === "connected");
  await sup.shutdown();
});

test("有効化確認への自動応答は input メッセージ（1 回だけ）。割れた文字列でも拾う。autoConsent: false なら送らない", async () => {
  const { sup } = make();
  await sup.start("pm1");
  const w = launches[0].child;
  w.text("Enable Remote Con");
  w.text("trol? (y/n)");
  await until(() => w.inputs().length === 1);
  assert.deepEqual(w.inputs(), ["y\r"]);
  w.text("Enable Remote Control? (y/n)");
  await sleep(40);
  assert.equal(w.inputs().length, 1);
  await sup.shutdown();

  cfg = parseConfig({ remoteControl: { claude: "fake-claude", autoConsent: false }, logDir: join(dir, "logs2") }, join(dir, "c.json"));
  const m = make();
  await m.sup.start("pm1");
  const w2 = launches[1].child;
  w2.text("Enable Remote Control? (y/n)");
  await sleep(40);
  assert.deepEqual(w2.inputs(), []);
  await m.sup.shutdown();
});

test("core の input / resize は wrapper の stdin へ input / resize 行として渡る。次の起動のサイズ初期値になる", async () => {
  const { sup, core } = make();
  await sup.start("pm1");
  const w = launches[0].child;
  assert.equal(core.input("pm1", Buffer.from("ls\r")), true);
  assert.equal(core.resize("pm1", 150, 50), true);
  await until(() => w.lines.length === 2);
  assert.deepEqual(w.lines, [{ t: "input", data: Buffer.from("ls\r").toString("base64") }, { t: "resize", cols: 150, rows: 50 }]);
  w.finish(1, null);
  await until(() => launches.length === 2);
  assert.deepEqual(launches[1].args.slice(0, 4), ["--cols", "150", "--rows", "50"]);
  await sup.shutdown();
});

test("異常終了で再起動: --continue 付き・新しい token・queue と ID は続く。古い token は無効", async () => {
  const { sup, core, tokens } = make();
  await sup.start("pm1");
  const first = launches[0];
  first.child.out("a");
  first.child.text("https://claude.ai/code/session_aaa\n");
  await until(() => sup.status("pm1").state === "connected");
  first.child.finish(1, null);
  await until(() => launches.length === 2);
  const second = launches[1];
  assert.ok(second.args.includes("--continue"));
  assert.equal(second.args[second.args.length - 1], "--continue");
  assert.notEqual(second.env.BANTOU_SESSION_TOKEN, first.env.BANTOU_SESSION_TOKEN);
  assert.equal(tokens.verify("pm1", first.env.BANTOU_SESSION_TOKEN!), false);
  assert.equal(tokens.verify("pm1", second.env.BANTOU_SESSION_TOKEN!), true);
  assert.equal(sup.status("pm1").lastExit?.code, 1); // wrapper の exit メッセージの code（wrapper 自身は 0）
  second.child.out("b");
  await until(() => chunks(core, "pm1").length === 2);
  assert.deepEqual(chunks(core, "pm1"), ["1:a", "2:b"]);
  assert.equal(sup.status("pm1").restarts, 1);
  await sup.shutdown();
});

test("resume 起動: --continue で接続前に早期終了したら素の起動へ fallback（--continue 無し）", async () => {
  const { sup } = make();
  await sup.start("pm1", { resume: true });
  assert.ok(launches[0].args.includes("--continue"));
  launches[0].child.text("No conversation found to continue\n");
  launches[0].child.finish(1, null);
  await until(() => launches.length === 2);
  assert.ok(!launches[1].args.includes("--continue"));
  assert.equal(sup.status("pm1").restarts, 0); // fallback は再起動回数に数えない
  launches[1].child.text("/remote-control is active https://claude.ai/code/session_zzz\n");
  await until(() => sup.status("pm1").state === "connected");
  await sup.shutdown();
});

test("接続直前の text と exit が同時に来ても、exit 後に残った text を見てから終了を判定する", async () => {
  const { sup } = make();
  await sup.start("pm1", { resume: true });
  const w = launches[0].child;
  // 接続した直後に落ちる: 接続済みなので fallback せず通常の再起動（--continue）
  w.text("/remote-control is active https://claude.ai/code/session_q\n");
  w.finish(2, null);
  await until(() => launches.length === 2);
  assert.ok(launches[1].args.includes("--continue"));
  assert.match(sup.status("pm1").sessionUrl ?? "", /session_q|^$/);
  await sup.shutdown();
});

test("stop: wrapper へ stop メッセージを送って終了を待つ。stopped になり再起動しない。remove で core からも外れる", async () => {
  const { sup, core } = make();
  await sup.start("pm1");
  const w = launches[0].child;
  core.push("pm1", Buffer.from("x"));
  const st = await sup.stop("pm1");
  assert.equal(st.state, "stopped");
  assert.ok(w.lines.some((l) => l.t === "stop"));
  assert.deepEqual(w.signals, []); // signal は使わず stop メッセージで止まった
  assert.equal(core.running("pm1"), false);
  await sleep(100);
  assert.equal(launches.length, 1);
  await sup.remove("pm1");
  assert.equal(core.has("pm1"), false);
});

test("stop: wrapper が stop に応じなければ猶予後に SIGKILL", async () => {
  const { sup } = make();
  await sup.start("pm1");
  const w = launches[0].child;
  w.stdin.write = ((_c: unknown, cb?: () => void) => (cb?.(), true)) as unknown as typeof w.stdin.write; // stop を握りつぶす
  w.kill = (sig: NodeJS.Signals | number = "SIGTERM") => {
    w.signals.push(String(sig));
    if (sig === "SIGKILL") setImmediate(() => w.rawExit(137));
    return true;
  };
  await sup.stop("pm1");
  assert.deepEqual(w.signals, ["SIGKILL"]);
});

test("ログ: text がログファイルに書かれる（JSON 行そのものではない）", async () => {
  const { sup } = make();
  await sup.start("pm1");
  launches[0].child.text("hello log\n");
  await sleep(30);
  await sup.stop("pm1");
  await sleep(50);
  const log = await readFile(join(dir, "logs", "pm1.log"), "utf8");
  assert.match(log, /hello log/);
  assert.ok(!log.includes('"t":"text"'));
});

test("add: wrapper 設定が無い supervisor では wrapper 起動の project を足せない。config 由来 project は従来どおり起動", async () => {
  const plain = createRemoteControlSupervisor({ config: cfg, log: () => {}, spawnImpl });
  assert.throws(() => plain.add(project, { wrapper: true }), /wrapper の設定/);
  const { sup } = make();
  sup.add({ ...project, name: "rc1", path: "/tmp/rc1" }); // wrapper 指定なし = 従来の remote-control
  await sup.start("rc1");
  const l = launches.find((x) => x.cwd === "/tmp/rc1")!;
  assert.equal(l.cmd, "fake-claude");
  assert.equal(l.args[0], "remote-control");
  assert.equal(l.env.BANTOU_SESSION_TOKEN, undefined);
  await sup.shutdown();
});

test("wrapper.ts: 引数組み立て / プロトコル行の解釈 / 窓の照合 / wrapper の場所", () => {
  assert.deepEqual(
    buildWrapperArgs({ claudePath: "c", name: "n", permissionMode: "auto", mcpConfig: null, resume: true, cols: 90, rows: 30 }),
    ["--cols", "90", "--rows", "30", "--", "c", "--remote-control", "n", "--permission-mode", "auto", "--continue"],
  );
  assert.equal(JSON.parse(mcpConfigJson("http://h/mcp/session", "n")).mcpServers.bantou.headers["X-Bantou-Session"], "n");
  assert.deepEqual(parseWrapperLine('{"t":"started","pid":5}'), { t: "started", pid: 5 });
  assert.deepEqual(parseWrapperLine('{"t":"exit","code":null,"signal":"SIGTERM"}'), { t: "exit", code: null, signal: "SIGTERM" });
  assert.deepEqual(parseWrapperLine(`{"t":"output","data":"${Buffer.from("é").toString("base64")}"}`), { t: "output", data: Buffer.from("é") });
  assert.equal(parseWrapperLine("not json"), null);
  assert.equal(parseWrapperLine('{"t":"weird"}'), null);
  assert.equal(parseWrapperLine('{"t":"input"}'), null);
  assert.equal(findSessionUrl("a https://claude.ai/code/session_ab_1-2\nb"), "https://claude.ai/code/session_ab_1-2");
  assert.equal(findSessionUrl("https://claude.ai/code/session_ab"), undefined); // 窓の末尾で切れている
  assert.equal(findSessionUrl("x https://claude.ai/code/session_a\n y https://claude.ai/code/session_b\n"), "https://claude.ai/code/session_b");
  assert.equal(windowConnected("/rc connecting…"), false);
  assert.equal(windowConnected("/remote-control is active"), true);
  assert.equal(resolveWrapperPath({ BANTOU_PTY_WRAPPER: "/x/w" }, "/opt/node"), "/x/w");
  assert.equal(resolveWrapperPath({}, "/opt/bin/center"), join("/opt/bin", process.platform === "win32" ? "bantou-pty-wrapper.exe" : "bantou-pty-wrapper"));
});
