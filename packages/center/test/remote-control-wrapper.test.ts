import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

function make(opts: { mcpUrl?: string | null; configPath?: string; logs?: string[]; instructions?: string } = {}) {
  const core = createCore();
  const tokens = createSessionTokens();
  const url = opts.mcpUrl === undefined ? "http://127.0.0.1:4567/mcp/session" : opts.mcpUrl;
  const sup = createRemoteControlSupervisor({
    config: cfg,
    ...(opts.configPath ? { configPath: opts.configPath } : {}),
    log: (m) => void opts.logs?.push(m),
    spawnImpl,
    wrapper: { core, tokens, path: "/fake/bantou-pty-wrapper", mcpUrl: () => url },
  });
  sup.add(project, { wrapper: true, ...(opts.instructions !== undefined ? { instructions: opts.instructions } : {}) });
  return { sup, core, tokens };
}

const chunks = (core: ReturnType<typeof createCore>, name: string): string[] => {
  const out: string[] = [];
  const evs: CoreEvent[] = [];
  core.subscribe(name, undefined, (e) => evs.push(e))!();
  for (const e of evs) if (e.type === "chunk") out.push(`${e.id}:${e.data.toString()}`);
  return out;
};

test("wrapper 起動: remoteControl.model があれば --model を付け、再起動(--continue)でも同じ", async () => {
  cfg = parseConfig(
    { remoteControl: { claude: "fake-claude", model: "opus", restartDelayMs: 30, maxRestarts: 2, stopGraceMs: 200 }, logDir: join(dir, "logs") },
    join(dir, "c.json"),
  );
  const { sup } = make();
  await sup.start("pm1");
  const args = launches[0].args;
  const i = args.indexOf("--model");
  assert.ok(i > 0);
  assert.equal(args[i + 1], "opus");
  assert.ok(i < args.indexOf("--mcp-config"));
  await sup.stop("pm1");
});

test("wrapper 起動: remoteControl.model が無ければ --model を付けない", async () => {
  const { sup } = make();
  await sup.start("pm1");
  assert.ok(!launches[0].args.includes("--model"));
  await sup.stop("pm1");
});

const valueOf = (args: string[], flag: string): string | undefined => {
  const i = args.indexOf(flag);
  return i < 0 ? undefined : args[i + 1];
};

test("wrapper 起動: instructions があれば --append-system-prompt <値> を付ける。複数行・記号もそのまま 1 引数で届く", async () => {
  const text = "1 行目\n  2 行目 \"q\" 'q' $HOME `x` ; | & 日本語\n\n末尾";
  const { sup } = make({ instructions: text });
  const st = await sup.start("pm1");
  const args = launches[0].args;
  assert.equal(args.filter((a) => a === "--append-system-prompt").length, 1);
  assert.equal(valueOf(args, "--append-system-prompt"), text);
  assert.ok(args.includes(text)); // 分割されず 1 要素のまま
  assert.equal(st.instructions, true);
  assert.equal(sup.status("pm1").instructions, true);
  // status と log に本文は出ない（長さだけ）
  assert.ok(!sup.status("pm1").args!.some((a) => a.includes("2 行目")));
  assert.equal(valueOf(sup.status("pm1").args!, "--append-system-prompt"), `<${text.length} 文字>`);
  await sup.stop("pm1");
});

test("wrapper 起動: instructions が空文字・未指定なら付けない（instructions は false）", async () => {
  for (const v of ["", undefined]) {
    launches.length = 0;
    const { sup } = make(v === undefined ? {} : { instructions: v });
    await sup.start("pm1");
    assert.ok(!launches[0].args.includes("--append-system-prompt"), JSON.stringify(v));
    assert.equal(sup.status("pm1").instructions, false);
    await sup.shutdown();
  }
});

test("wrapper 起動: instructions は再起動と resume（--continue）でも付く", async () => {
  const { sup } = make({ instructions: "常に日本語で答える\n二行目" });
  await sup.start("pm1", { resume: true });
  assert.ok(launches[0].args.includes("--continue"));
  assert.equal(valueOf(launches[0].args, "--append-system-prompt"), "常に日本語で答える\n二行目");
  launches[0].child.out("a");
  launches[0].child.text("https://claude.ai/code/session_aaa\n");
  await until(() => sup.status("pm1").state === "connected");
  launches[0].child.finish(1, null);
  await until(() => launches.length === 2);
  assert.ok(launches[1].args.includes("--continue"));
  assert.equal(valueOf(launches[1].args, "--append-system-prompt"), "常に日本語で答える\n二行目");
  assert.equal(sup.status("pm1").instructions, true);
  await sup.shutdown();
});

test("wrapper 起動: --continue が失敗して素の起動へ fallback しても instructions は付く", async () => {
  const { sup } = make({ instructions: "fallback でも付く" });
  await sup.start("pm1", { resume: true });
  launches[0].child.text("No conversation found to continue\n");
  launches[0].child.finish(1, null);
  await until(() => launches.length === 2);
  assert.ok(!launches[1].args.includes("--continue"));
  assert.equal(valueOf(launches[1].args, "--append-system-prompt"), "fallback でも付く");
  await sup.shutdown();
});

test("buildWrapperArgs: appendSystemPrompt は --mcp-config の前に 1 組だけ。空・未指定は付けない", () => {
  const base = { claudePath: "c", name: "n", permissionMode: "auto", mcpConfig: "{}", resume: false };
  const a = buildWrapperArgs({ ...base, appendSystemPrompt: "x\ny" });
  assert.equal(a[a.indexOf("--append-system-prompt") + 1], "x\ny");
  assert.ok(a.indexOf("--append-system-prompt") < a.indexOf("--mcp-config"));
  assert.ok(!buildWrapperArgs({ ...base, appendSystemPrompt: "" }).includes("--append-system-prompt"));
  assert.ok(!buildWrapperArgs(base).includes("--append-system-prompt"));
});

test("wrapper 起動: wrapper -- claude --remote-control の引数、env の token、--mcp-config は JSON 文字列で token は ${VAR}", async () => {
  const { sup, tokens } = make();
  await sup.start("pm1");
  assert.equal(launches.length, 1);
  const l = launches[0];
  assert.equal(l.cmd, "/fake/bantou-pty-wrapper");
  assert.equal(l.cwd, "/tmp/pm1");
  assert.deepEqual(l.args.slice(0, 6), ["--cols", "120", "--rows", "40", "--", "fake-claude"]);
  assert.deepEqual(l.args.slice(6, 11), ["--remote-control", "pm1", "--permission-mode", "plan", "--no-chrome"]);
  assert.equal(l.args[11], "--mcp-config");
  assert.equal(l.args.length, 13); // 初回は --continue 無し
  const json = JSON.parse(l.args[12]) as { mcpServers: { bantou: Record<string, unknown>; "bantou-messenger": Record<string, unknown> } };
  // session 名が messenger の peer 名になる（名前は MCP の env だけ。claude 子プロセスの env には入れない）
  assert.deepEqual(json.mcpServers["bantou-messenger"], {
    type: "stdio",
    command: "npx",
    args: ["-y", "@unagents/messenger@0.12.0", "mcp"],
    env: { AGENT_MESSENGER_NAME: "pm1", AGENT_MESSENGER_CLIENT_SPEC: "0.12.0" },
  });
  assert.equal(l.env.AGENT_MESSENGER_NAME, undefined);
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

test("http 窓口が無い（mcpUrl が null）時も --mcp-config を付け、messenger だけが入る", async () => {
  const { sup } = make({ mcpUrl: null });
  await sup.start("pm1");
  const i = launches[0].args.indexOf("--mcp-config");
  assert.ok(i >= 0);
  const json = JSON.parse(launches[0].args[i + 1]) as { mcpServers: Record<string, { env?: Record<string, string> }> };
  assert.deepEqual(Object.keys(json.mcpServers), ["bantou-messenger"]);
  assert.equal(json.mcpServers["bantou-messenger"].env?.AGENT_MESSENGER_NAME, "pm1");
  await sup.shutdown();
});

test("再起動（--continue）でも同じ session 名で messenger の peer 名が付く", async () => {
  const { sup } = make();
  await sup.start("pm1", { resume: true });
  const a = launches[launches.length - 1].args;
  assert.ok(a.includes("--continue"));
  const json = JSON.parse(a[a.indexOf("--mcp-config") + 1]) as { mcpServers: Record<string, { env?: Record<string, string> }> };
  assert.equal(json.mcpServers["bantou-messenger"].env?.AGENT_MESSENGER_NAME, "pm1");
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
    ["--cols", "90", "--rows", "30", "--", "c", "--remote-control", "n", "--permission-mode", "auto", "--no-chrome", "--continue"],
  );
  // model: 指定時だけ --model を付ける（mcp-config の前）。無ければ従来どおり
  assert.deepEqual(
    buildWrapperArgs({ claudePath: "c", name: "n", permissionMode: "auto", mcpConfig: "{}", resume: false, model: "opus[1m]" }),
    ["--cols", "120", "--rows", "40", "--", "c", "--remote-control", "n", "--permission-mode", "auto", "--no-chrome", "--model", "opus[1m]", "--mcp-config", "{}"],
  );
  assert.ok(!buildWrapperArgs({ claudePath: "c", name: "n", permissionMode: "auto", mcpConfig: null, resume: false }).includes("--model"));
  assert.equal(JSON.parse(mcpConfigJson("http://h/mcp/session", "n")).mcpServers.bantou.headers["X-Bantou-Session"], "n");
  assert.equal(JSON.parse(mcpConfigJson("http://h/mcp/session", "n")).mcpServers["bantou-messenger"].env.AGENT_MESSENGER_NAME, "n");
  assert.equal(JSON.parse(mcpConfigJson(null, "n")).mcpServers.bantou, undefined);
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

/** center.json の remoteControl だけを書き換える（再読込のテスト用）。 */
const writeRc = (path: string, rc: Record<string, unknown>): Promise<void> =>
  writeFile(path, JSON.stringify({ remoteControl: { claude: "fake-claude", restartDelayMs: 30, maxRestarts: 2, stopGraceMs: 200, ...rc }, logDir: join(dir, "logs") }));

test("読み直し: 保存後の起動（新規・再起動・resume 失敗後の素の起動）で新しい model が使われる。動いている session は変わらない。instructions は読み直しの対象外", async () => {
  const path = join(dir, "reload.json");
  await writeRc(path, { model: "opus" });
  cfg = parseConfig(JSON.parse(await readFile(path, "utf8")), path);
  const logs: string[] = [];
  const { sup } = make({ configPath: path, logs, instructions: "記録の値" });
  await sup.start("pm1");
  assert.equal(valueOf(launches[0].args, "--model"), "opus");
  assert.equal(valueOf(launches[0].args, "--append-system-prompt"), "記録の値");
  // center.json の sessionInstructions は無視（記録の値のまま）
  await writeRc(path, { sessionInstructions: "ファイルの値", model: "sonnet" });
  launches[0].child.out("a");
  launches[0].child.text("https://claude.ai/code/session_aaa\n");
  await until(() => sup.status("pm1").state === "connected");
  launches[0].child.finish(1, null);
  await until(() => launches.length === 2);
  assert.equal(valueOf(launches[1].args, "--model"), "sonnet");
  assert.equal(valueOf(launches[1].args, "--append-system-prompt"), "記録の値");
  // resume 失敗後の素の起動でも記録の値
  await writeRc(path, {});
  launches[1].child.text("No conversation found to continue\n");
  launches[1].child.finish(1, null);
  await until(() => launches.length === 3);
  assert.equal(valueOf(launches[2].args, "--append-system-prompt"), "記録の値");
  assert.ok(!launches[2].args.includes("--model"));
  assert.ok(!logs.some((l) => l.includes("読み直しに失敗")));
  await sup.shutdown();
});

test("setInstructions: 次の起動から新しい値（再起動でも）。空で解除。動いている session の args は変わらない", async () => {
  const { sup } = make({ instructions: "旧" });
  await sup.start("pm1");
  assert.equal(valueOf(launches[0].args, "--append-system-prompt"), "旧");
  sup.setInstructions("pm1", "新");
  assert.equal(valueOf(sup.status("pm1").args!, "--append-system-prompt"), "<1 文字>"); // 動いている分は変わらない
  assert.equal(launches.length, 1);
  launches[0].child.finish(1, null);
  await until(() => launches.length === 2);
  assert.equal(valueOf(launches[1].args, "--append-system-prompt"), "新"); // 異常終了後の再起動
  assert.ok(launches[1].args.includes("--continue"));
  await sup.stop("pm1");
  sup.setInstructions("pm1", "");
  await sup.start("pm1");
  assert.ok(!launches[2].args.includes("--append-system-prompt"));
  assert.equal(sup.status("pm1").instructions, false);
  assert.throws(() => sup.setInstructions("nope", "x"), /未定義の project/);
  await sup.shutdown();
});

test("読み直し: ファイルが壊れている・無い・検証 NG の時は直前に読めた値で起動し、理由を log に残す", async () => {
  const path = join(dir, "reload.json");
  await writeRc(path, { model: "opus" });
  cfg = parseConfig(JSON.parse(await readFile(path, "utf8")), path);
  const logs: string[] = [];
  const { sup } = make({ configPath: path, logs, instructions: "秘密の本文" });
  await writeRc(path, { model: "sonnet" });
  await sup.start("pm1");
  assert.equal(valueOf(launches[0].args, "--model"), "sonnet");
  await sup.stop("pm1");
  await writeFile(path, "{ broken");
  await sup.start("pm1");
  assert.equal(valueOf(launches[1].args, "--model"), "sonnet");
  assert.equal(valueOf(launches[1].args, "--append-system-prompt"), "秘密の本文");
  assert.ok(logs.some((l) => l.includes("読み直しに失敗") && l.includes("JSON として不正")), logs.join("\n"));
  await sup.stop("pm1");
  await writeRc(path, { model: "-bad" });
  await sup.start("pm1");
  assert.equal(valueOf(launches[2].args, "--model"), "sonnet");
  assert.ok(logs.some((l) => l.includes("読み直しに失敗") && l.includes("config が不正")));
  await sup.stop("pm1");
  await rm(path);
  await sup.start("pm1");
  assert.equal(valueOf(launches[3].args, "--model"), "sonnet");
  assert.ok(logs.some((l) => l.includes("読み直しに失敗") && l.includes("config を読めない")));
  assert.ok(!logs.some((l) => l.includes("秘密の本文")), "本文は log に出ない");
  await sup.shutdown();
});

test("読み直し: configPath 無しなら起動時の値のまま（従来動作）", async () => {
  const { sup } = make({ instructions: "固定" });
  await sup.start("pm1");
  assert.equal(valueOf(launches[0].args, "--append-system-prompt"), "固定");
  await sup.shutdown();
});
