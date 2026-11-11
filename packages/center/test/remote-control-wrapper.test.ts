import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { afterEach, beforeEach, test } from "node:test";
import { parseConfig, type Config, type ProjectConfig } from "../src/config.js";
import { createCore, type CoreEvent } from "../src/core.js";
import { createRemoteControlSupervisor, type ChildLike, type SpawnImpl } from "../src/remote-control.js";
import { createSessionTokens } from "../src/session-auth.js";
import { applicableParts, buildSystemInstructions, partLabel } from "../src/system-instructions.js";
import { bantouAllowRules, buildWrapperArgs, findSessionUrl, mcpConfigJson, parseWrapperLine, resolveWrapperPath, windowConnected } from "../src/wrapper.js";

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

function make(opts: { mcpUrl?: string | null; configPath?: string; logs?: string[]; instructions?: string; addDirs?: string[]; outputStyle?: string; path?: string; system?: string; memory?: { url: string; token?: string; agentId?: string }; realSystem?: boolean } = {}) {
  const core = createCore();
  const tokens = createSessionTokens();
  const url = opts.mcpUrl === undefined ? "http://127.0.0.1:4567/mcp/session" : opts.mcpUrl;
  const sup = createRemoteControlSupervisor({
    config: cfg,
    ...(opts.configPath ? { configPath: opts.configPath } : {}),
    log: (m) => void opts.logs?.push(m),
    spawnImpl,
    wrapper: { core, tokens, path: "/fake/bantou-pty-wrapper", mcpUrl: () => url, statusLineSelf: ["/fake/bantou-center"] },
    ...(opts.realSystem ? { systemInstructions: { build: (ctx: { session: string; memory?: boolean }) => buildSystemInstructions(ctx), labels: (ctx: { session: string; memory?: boolean }) => applicableParts(ctx).map(partLabel) } } : {}),
    ...(opts.system !== undefined ? { systemInstructions: { build: ({ session }: { session: string }) => opts.system!.replace("{session}", session), labels: ["t@1"] } } : {}),
  });
  sup.add(
    { ...project, ...(opts.path ? { path: opts.path } : {}) },
    {
      wrapper: true,
      ...(opts.instructions !== undefined ? { instructions: opts.instructions } : {}),
      ...(opts.addDirs ? { addDirs: opts.addDirs } : {}),
      ...(opts.outputStyle !== undefined ? { outputStyle: opts.outputStyle } : {}),
      ...(opts.memory ? { memory: opts.memory } : {}),
    },
  );
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

test("buildWrapperArgs: addDirs は --add-dir <path> を 1 つずつ、--append-system-prompt の後・--mcp-config の前。空・未指定は付けない", () => {
  const base = { claudePath: "c", name: "n", permissionMode: "auto", mcpConfig: "{}", resume: false };
  const a = buildWrapperArgs({ ...base, appendSystemPrompt: "x", addDirs: ["/d one", "/d2"] });
  const i = a.indexOf("--add-dir");
  assert.deepEqual(a.slice(i, i + 4), ["--add-dir", "/d one", "--add-dir", "/d2"]);
  assert.ok(a.indexOf("--append-system-prompt") < i && i < a.indexOf("--mcp-config"));
  assert.ok(!buildWrapperArgs({ ...base, addDirs: [] }).includes("--add-dir"));
  assert.ok(!buildWrapperArgs(base).includes("--add-dir"));
});

test("wrapper 起動: addDirs は --add-dir で付き、setAddDirs は次の起動（再起動・resume）から効く", async () => {
  const { sup } = make({ addDirs: ["/ref/a"] });
  await sup.start("pm1");
  const dirsOf = (args: string[]) => args.flatMap((a, i) => (a === "--add-dir" ? [args[i + 1]] : []));
  assert.deepEqual(dirsOf(launches[0].args), ["/ref/a"]);
  assert.deepEqual(dirsOf(sup.status("pm1").args!), ["/ref/a"]); // 本文の伏せ字は不要（path は status に出る）
  sup.setAddDirs("pm1", ["/ref/b", "/ref/c"]);
  assert.deepEqual(dirsOf(sup.status("pm1").args!), ["/ref/a"]); // 動いている間は変わらない
  await sup.stop("pm1");
  await sup.start("pm1", { resume: true });
  assert.deepEqual(dirsOf(launches[1].args), ["/ref/b", "/ref/c"]);
  assert.ok(launches[1].args.includes("--continue"));
  sup.setAddDirs("pm1", []);
  await sup.stop("pm1");
  await sup.start("pm1");
  assert.ok(!launches[2].args.includes("--add-dir"));
  await sup.stop("pm1");
});

test("wrapper 起動: outputStyle があれば <path>/.claude/output-styles/bantou.md に書き --settings に outputStyle: bantou を付ける。setOutputStyle は次の起動から。空で解除しファイルも消す", async () => {
  const path = join(dir, "pm1");
  await mkdir(path, { recursive: true });
  const logs: string[] = [];
  const { sup } = make({ outputStyle: "Be brief.", path, logs });
  const file = join(path, ".claude", "output-styles", "bantou.md");
  const settingsOf = (args: string[]) => JSON.parse(valueOf(args, "--settings")!) as Record<string, unknown>;
  await sup.start("pm1");
  assert.equal(settingsOf(launches[0].args).outputStyle, "bantou");
  assert.ok("statusLine" in settingsOf(launches[0].args)); // 既存の statusLine / hooks はそのまま
  assert.ok((await readFile(file, "utf8")).startsWith("---\nname: bantou\n"));
  assert.ok((await readFile(file, "utf8")).endsWith("Be brief.\n"));
  sup.setOutputStyle("pm1", "Changed.");
  assert.ok((await readFile(file, "utf8")).endsWith("Be brief.\n")); // 動いている間は変わらない
  await sup.stop("pm1");
  await sup.start("pm1", { resume: true });
  assert.ok((await readFile(file, "utf8")).endsWith("Changed.\n"));
  assert.equal(settingsOf(launches[1].args).outputStyle, "bantou");
  await sup.stop("pm1");
  sup.setOutputStyle("pm1", "");
  await sup.start("pm1");
  assert.equal(settingsOf(launches[2].args).outputStyle, undefined);
  await assert.rejects(readFile(file, "utf8"));
  assert.throws(() => sup.setOutputStyle("nope", "x"), /未定義の project/);
  await sup.shutdown();
});

test("wrapper 起動: outputStyle だけ（MCP 窓口が無い stdio）でも --settings に outputStyle を付ける。書けない時は log に出して style 無しで起動する", async () => {
  const path = join(dir, "pm1");
  await mkdir(path, { recursive: true });
  const { sup } = make({ outputStyle: "Be brief.", path, mcpUrl: null });
  await sup.start("pm1");
  assert.deepEqual(JSON.parse(valueOf(launches[0].args, "--settings")!), { outputStyle: "bantou", permissions: { allow: ["mcp__bantou-messenger__*"] } });
  await sup.shutdown();
  // path が普通のファイル: .claude/ を作れない
  const blocked = join(dir, "blocked");
  await writeFile(blocked, "x");
  const logs: string[] = [];
  const { sup: sup2 } = make({ outputStyle: "Be brief.", path: blocked, logs });
  await sup2.start("pm1");
  assert.equal(JSON.parse(valueOf(launches[1].args, "--settings")!).outputStyle, undefined);
  assert.ok(logs.some((l) => l.includes("出力スタイルを書けない")));
  await sup2.shutdown();
});

test("buildWrapperArgs: appendSystemPrompt は --mcp-config の前に 1 組だけ。空・未指定は付けない", () => {
  const base = { claudePath: "c", name: "n", permissionMode: "auto", mcpConfig: "{}", resume: false };
  const a = buildWrapperArgs({ ...base, appendSystemPrompt: "x\ny" });
  assert.equal(a[a.indexOf("--append-system-prompt") + 1], "x\ny");
  assert.ok(a.indexOf("--append-system-prompt") < a.indexOf("--mcp-config"));
  assert.ok(!buildWrapperArgs({ ...base, appendSystemPrompt: "" }).includes("--append-system-prompt"));
  assert.ok(!buildWrapperArgs(base).includes("--append-system-prompt"));
});

test("wrapper 起動: instructions と statusLine の --settings が両方付く（--append-system-prompt は 1 回、--settings は statusLine のみ）", async () => {
  const { sup } = make({ instructions: "追加指示" });
  await sup.start("pm1");
  const args = launches[0].args;
  assert.equal(valueOf(args, "--append-system-prompt"), "追加指示");
  assert.equal(args.filter((a) => a === "--settings").length, 1);
  const settings = JSON.parse(valueOf(args, "--settings")!) as Record<string, unknown>;
  assert.deepEqual(Object.keys(settings).sort(), ["hooks", "permissions", "statusLine"]);
  assert.ok(args.indexOf("--append-system-prompt") < args.indexOf("--mcp-config"));
  assert.ok(args.indexOf("--mcp-config") < args.indexOf("--settings"));
  await sup.stop("pm1");
});

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
  assert.equal(l.args[12], "--settings");
  assert.equal(l.args.length, 14); // 初回は --continue 無し
  // statusLine は center のサブコマンド。--settings は statusLine のキーだけ。token は argv に載せない
  const settings = JSON.parse(l.args[13]) as Record<string, { type: string; command: string }>;
  assert.deepEqual(Object.keys(settings).sort(), ["hooks", "permissions", "statusLine"]);
  assert.equal(settings.statusLine.type, "command");
  assert.equal(settings.statusLine.command, "'/fake/bantou-center' 'status-line' '--url' 'http://127.0.0.1:4567/sessions/pm1/status-line'");
  const hooks = (settings as unknown as { hooks: Record<string, { hooks: { command: string; async: boolean }[] }[]> }).hooks;
  assert.equal(hooks.Stop[0].hooks[0].command, "'/fake/bantou-center' 'hook' '--url' 'http://127.0.0.1:4567/sessions/pm1/hook'");
  assert.equal(hooks.Stop[0].hooks[0].async, undefined, "Stop は同期");
  assert.equal(hooks.PreToolUse[0].hooks[0].async, true);
  const json = JSON.parse(l.args[11]) as { mcpServers: { bantou: Record<string, unknown>; "bantou-messenger": Record<string, unknown> } };
  // session 名が messenger の peer 名になる（名前は MCP の env だけ。claude 子プロセスの env には入れない）
  assert.deepEqual(json.mcpServers["bantou-messenger"], {
    type: "stdio",
    command: "npx",
    args: ["-y", "@unagents/messenger@0.12.2", "mcp"],
    env: { AGENT_MESSENGER_NAME: "pm1", AGENT_MESSENGER_CLIENT_SPEC: "0.12.2" },
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
  assert.deepEqual(JSON.parse(valueOf(launches[0].args, "--settings")!), { permissions: { allow: ["mcp__bantou-messenger__*"] } }, "窓口が無い時は statusLine / hooks も mcp__bantou も付けない");
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
    ["--cols", "90", "--rows", "30", "--", "c", "--remote-control", "n", "--permission-mode", "auto", "--continue"],
  );
  // model: 指定時だけ --model を付ける（mcp-config の前）。無ければ従来どおり
  assert.deepEqual(
    buildWrapperArgs({ claudePath: "c", name: "n", permissionMode: "auto", mcpConfig: "{}", resume: false, model: "opus[1m]" }),
    ["--cols", "120", "--rows", "40", "--", "c", "--remote-control", "n", "--permission-mode", "auto", "--model", "opus[1m]", "--mcp-config", "{}"],
  );
  assert.ok(!buildWrapperArgs({ claudePath: "c", name: "n", permissionMode: "auto", mcpConfig: null, resume: false }).includes("--model"));
  // settings: 指定時だけ --settings（mcp-config の後、--continue の前）
  assert.deepEqual(
    buildWrapperArgs({ claudePath: "c", name: "n", permissionMode: "auto", mcpConfig: "{}", settings: '{"statusLine":{}}', resume: true }),
    ["--cols", "120", "--rows", "40", "--", "c", "--remote-control", "n", "--permission-mode", "auto", "--mcp-config", "{}", "--settings", '{"statusLine":{}}', "--continue"],
  );
  assert.ok(!buildWrapperArgs({ claudePath: "c", name: "n", permissionMode: "auto", mcpConfig: null, settings: null, resume: false }).includes("--settings"));
  assert.equal(JSON.parse(mcpConfigJson("http://h/mcp/session", "n")).mcpServers.bantou.headers["X-Bantou-Session"], "n");
  assert.equal(JSON.parse(mcpConfigJson("http://h/mcp/session", "n")).mcpServers["bantou-messenger"].env.AGENT_MESSENGER_NAME, "n");
  assert.equal(JSON.parse(mcpConfigJson(null, "n")).mcpServers.bantou, undefined);
  // memory: 無ければ従来どおり（キーが増えない）。あれば type http、token がある時だけ Authorization（${BANTOU_MEMORY_TOKEN} のまま）、X-Agent-Id は agentId か session 名
  assert.deepEqual(Object.keys(JSON.parse(mcpConfigJson("http://h/mcp/session", "n")).mcpServers), ["bantou-messenger", "bantou"]);
  assert.equal(mcpConfigJson("http://h/mcp/session", "n", undefined), mcpConfigJson("http://h/mcp/session", "n"));
  assert.deepEqual(JSON.parse(mcpConfigJson("http://h/mcp/session", "n", { url: "http://m/mcp", token: "SECRET" })).mcpServers.memory, {
    type: "http",
    url: "http://m/mcp",
    headers: { Authorization: "Bearer ${BANTOU_MEMORY_TOKEN}", "X-Agent-Id": "n" },
  });
  assert.deepEqual(JSON.parse(mcpConfigJson(null, "n", { url: "http://m/mcp", agentId: "pm" })).mcpServers.memory.headers, { "X-Agent-Id": "pm" });
  assert.ok(!mcpConfigJson("http://h/mcp/session", "n", { url: "http://m/mcp", token: "SECRET" }).includes("SECRET"));
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

test("wrapper 起動: システム埋め込み指示は --append-system-prompt の先頭、利用者の追加指示は空行を挟んで後ろ。status の instructions は利用者分だけ、systemInstructions は部品の一覧", async () => {
  const { sup } = make({ system: "system for {session}", instructions: "利用者の指示" });
  const st = await sup.start("pm1");
  assert.equal(valueOf(launches[0].args, "--append-system-prompt"), "system for pm1\n\n利用者の指示");
  assert.equal(st.instructions, true);
  assert.deepEqual(st.systemInstructions, ["t@1"]);
  await sup.stop("pm1");
});

test("wrapper 起動: システム埋め込み指示だけなら instructions は false のまま付く。無ければ付けない", async () => {
  const a = make({ system: "only system" });
  const st = await a.sup.start("pm1");
  assert.equal(valueOf(launches[0].args, "--append-system-prompt"), "only system");
  assert.equal(st.instructions, false);
  await a.sup.stop("pm1");
  launches = [];
  const b = make({});
  const st2 = await b.sup.start("pm1");
  assert.ok(!launches[0].args.includes("--append-system-prompt"));
  assert.equal(st2.systemInstructions, undefined);
  await b.sup.stop("pm1");
});

test("buildWrapperArgs: --no-chrome は付けない", () => {
  const a = buildWrapperArgs({ claudePath: "c", name: "n", permissionMode: "auto", mcpConfig: "{}", resume: false });
  assert.ok(!a.includes("--no-chrome"));
});

// -- 認証状態の検知（/login まわり） --

import { detectAuthEvent, findLoginUrl, type RcStatus } from "../src/remote-control.js";

const LOGIN_URL =
  "https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&scope=org%3Acreate_api_key+user%3Aprofile&code_challenge=H_c6f4h2EM5AQOoZSnvA2SGVeg6HqnMePgq24CVI3ZM&code_challenge_method=S256&state=e62kJfVlI11dSfkwBwbnSOCrymD9OoiBr_FYy2NODus";

test("findLoginUrl: TUI の折返し（単独の改行）を跨いだ URL を 1 本にし、空行で終わる。途中で切れた URL は採らない", () => {
  const wrapped = `${LOGIN_URL.slice(0, 160)}\n${LOGIN_URL.slice(160, 320)}\n${LOGIN_URL.slice(320)}\n\n\nPaste code here if prompted >`;
  assert.equal(findLoginUrl(`Browser didn't open? Use the url below to sign in (c to copy)\n${wrapped}`), LOGIN_URL);
  assert.equal(findLoginUrl(LOGIN_URL.slice(0, 300)), undefined);
  assert.equal(findLoginUrl(`${LOGIN_URL} `), LOGIN_URL);
  assert.equal(findLoginUrl("https://claude.ai/code/session_x\n\n"), undefined);
});

test("detectAuthEvent: 文言ごとの種類。成功が最優先", () => {
  assert.deepEqual(detectAuthEvent("⏺ Please run /login · APIError: 401 OAuth access token has expired."), { kind: "login_required" });
  assert.deepEqual(detectAuthEvent("OAuth error: Couldn't save your login. If your Mac's keychain is locked, unlock it and login again."), { kind: "save_failed" });
  assert.deepEqual(detectAuthEvent("Invalid code. Please make sure the full code was copied"), { kind: "invalid_code" });
  assert.deepEqual(detectAuthEvent("Login successful. Press Enter to continue… Please run /login"), { kind: "success" });
  assert.equal(detectAuthEvent("❯ Checking for updates"), undefined);
});

test("wrapper 起動: pty の text から認証状態を拾い、変わった時だけ onAuthChange。起動で ok に戻る", async () => {
  const core = createCore();
  const tokens = createSessionTokens();
  const changes: [string, RcStatus["auth"], string | null, string | null][] = [];
  const sup = createRemoteControlSupervisor({
    config: cfg,
    log: () => {},
    spawnImpl,
    wrapper: { core, tokens, path: "/fake/bantou-pty-wrapper", mcpUrl: () => null },
    onAuthChange: (p, s) => changes.push([p, s.auth, s.loginUrl, s.loginError]),
  });
  sup.add(project, { wrapper: true });
  await sup.start("pm1");
  const w = launches[0].child;
  assert.equal(sup.status("pm1").auth, "ok");

  // 401: 文言がチャンクを跨いでも拾う。再描画で同じ文言が繰り返されても通知は 1 回
  w.text("⏺ Please run /lo");
  w.text("gin · APIError: 401 OAuth access token has expired.\n");
  await until(() => sup.status("pm1").auth === "login_required");
  w.text("⏺ Please run /login · APIError: 401 OAuth access token has expired.\n");
  w.text("⏺ Please run /login · APIError: 401 OAuth access token has expired.\n");
  await sleep(30);
  assert.deepEqual(changes, [["pm1", "login_required", null, null]]);

  // /login の URL（折返し・複数チャンク）
  w.text(`Browser didn't open? Use the url below to sign in (c to copy)\n${LOGIN_URL.slice(0, 200)}\n`);
  w.text(`${LOGIN_URL.slice(200)}\n\n\nPaste code here if prompted >\n`);
  await until(() => sup.status("pm1").loginUrl === LOGIN_URL);
  assert.equal(sup.status("pm1").auth, "login_required");

  // keychain ロックで保存失敗
  w.text("OAuth error: Couldn't save your login. If your Mac's keychain is locked, unlock it and login again.  Press Enter to retry.\n");
  await until(() => sup.status("pm1").auth === "keychain_locked");
  assert.equal(sup.status("pm1").loginError, "Couldn't save your login");
  assert.equal(sup.status("pm1").loginUrl, LOGIN_URL);

  // resetLogin は URL と失敗理由だけ消す
  sup.resetLogin("pm1");
  assert.deepEqual([sup.status("pm1").auth, sup.status("pm1").loginUrl, sup.status("pm1").loginError], ["keychain_locked", null, null]);

  // コード不正
  w.text("Invalid code. Please make sure the full code was copied\n");
  await until(() => sup.status("pm1").loginError === "Invalid code");

  // 成功で ok、URL と失敗理由は消える
  w.text("Login successful. Press Enter to continue…\n");
  await until(() => sup.status("pm1").auth === "ok");
  assert.deepEqual([sup.status("pm1").loginUrl, sup.status("pm1").loginError], [null, null]);
  assert.deepEqual(changes.map((c) => c.slice(1)), [
    ["login_required", null, null],
    ["login_required", LOGIN_URL, null],
    ["keychain_locked", LOGIN_URL, "Couldn't save your login"],
    ["keychain_locked", null, null],
    ["keychain_locked", null, "Invalid code"],
    ["ok", null, null],
  ]);

  // 再起動（exit → 再 launch）で ok に戻る（login_required のまま終了した場合）
  w.text("⏺ Please run /login\n");
  await until(() => sup.status("pm1").auth === "login_required");
  w.finish(1, null);
  await until(() => launches.length === 2 && sup.status("pm1").pid !== null);
  assert.equal(sup.status("pm1").auth, "ok");
  await sup.stop("pm1");
});

import { fuzzyIndexOf } from "../src/remote-control.js";

test("fuzzyIndexOf / detectAuthEvent: TUI の差分描画で空白と一部の文字が落ちた実出力も拾う。無関係な文はを拾わない", () => {
  // mac200 の bantou.log（wrapper の text）そのまま
  const real = "Esctocancel\nOAuth error: Could't ave yo login.IfyourMac'skeyhainislocked,unlockitandloginagain.  Press Enter to retry.Esctocancel\n";
  assert.deepEqual(detectAuthEvent(real), { kind: "save_failed" });
  assert.deepEqual(detectAuthEvent("⏺Pleaserun/login·APIError:401OAuthaccesstokenhasexpired.Re-authenticatetocontinue."), { kind: "login_required" });
  assert.deepEqual(detectAuthEvent("Loginsuccesful.PressEntertocontinue"), { kind: "success" });
  assert.deepEqual(detectAuthEvent("Invalidcode.Pleasemakesurethefullcodewascopied"), { kind: "invalid_code" });
  // 字抜けが多すぎる・別の文
  assert.equal(detectAuthEvent("Cold sve yor lgin"), undefined);
  assert.equal(detectAuthEvent("Please run /logout"), undefined);
  assert.equal(detectAuthEvent("Login failed: invalid grant"), undefined);
  assert.equal(detectAuthEvent("The code is valid. Paste code here if prompted >"), undefined);
  assert.equal(fuzzyIndexOf("xxCould'taveyologinyy", "Couldn't save your login", 4), 2);
  assert.equal(fuzzyIndexOf("xxCould'taveyologinyy", "Couldn't save your login", 3), -1);
  assert.equal(fuzzyIndexOf("abc", "", 1), -1);
});

const mcpOf = (args: string[]) => JSON.parse(valueOf(args, "--mcp-config")!) as { mcpServers: Record<string, { type?: string; url?: string; headers?: Record<string, string> }> };

test("memory: --mcp-config に memory（type http、Authorization は ${BANTOU_MEMORY_TOKEN}、X-Agent-Id は agentId か session 名）を足し、token は子の env だけで渡す。argv・mcp-config・status・log に token の実値は出ない。再起動・--continue でも同じ", async () => {
  const SECRET = "tok-SECRET-0123456789";
  const logs: string[] = [];
  const { sup } = make({ memory: { url: "http://mem.local:3000/mcp", token: SECRET }, logs });
  const st = await sup.start("pm1");
  const l = launches[0];
  const mem = mcpOf(l.args).mcpServers.memory;
  assert.deepEqual(mem, { type: "http", url: "http://mem.local:3000/mcp", headers: { Authorization: "Bearer ${BANTOU_MEMORY_TOKEN}", "X-Agent-Id": "pm1" } });
  assert.equal(l.env.BANTOU_MEMORY_TOKEN, SECRET);
  assert.ok(l.env.BANTOU_SESSION_TOKEN); // session token と並ぶ
  // token を探す: argv（mcp-config 含む）・status・list・log・wrapper への入力行
  const hay = JSON.stringify([l.args, st, sup.status("pm1"), sup.list(), logs, l.child.lines]);
  assert.ok(!hay.includes(SECRET));
  assert.ok(hay.includes("BANTOU_MEMORY_TOKEN")); // placeholder は残る
  await sup.stop("pm1");
  await sup.start("pm1", { resume: true });
  assert.equal(launches[1].env.BANTOU_MEMORY_TOKEN, SECRET);
  assert.deepEqual(mcpOf(launches[1].args).mcpServers.memory, mem);
  assert.ok(launches[1].args.includes("--continue"));
  // 差し替え: agentId 指定・token 無しなら Authorization を付けず env も渡さない（process の同名 env を継承しない）
  const prev = process.env.BANTOU_MEMORY_TOKEN;
  process.env.BANTOU_MEMORY_TOKEN = "INHERITED-SECRET";
  try {
    await sup.stop("pm1");
    sup.setMemory("pm1", { url: "https://m2.example/mcp", agentId: "agent-9" });
    await sup.start("pm1");
    const l2 = launches[2];
    assert.deepEqual(mcpOf(l2.args).mcpServers.memory, { type: "http", url: "https://m2.example/mcp", headers: { "X-Agent-Id": "agent-9" } });
    assert.equal(l2.env.BANTOU_MEMORY_TOKEN, undefined);
    assert.ok(!JSON.stringify([l2.args, sup.status("pm1")]).includes("INHERITED-SECRET"));
    // memory を外す: mcp-config に memory が無い
    await sup.stop("pm1");
    sup.setMemory("pm1", undefined);
    await sup.start("pm1");
    assert.equal(mcpOf(launches[3].args).mcpServers.memory, undefined);
    assert.equal(launches[3].env.BANTOU_MEMORY_TOKEN, undefined);
  } finally {
    if (prev === undefined) delete process.env.BANTOU_MEMORY_TOKEN;
    else process.env.BANTOU_MEMORY_TOKEN = prev;
  }
  assert.throws(() => sup.setMemory("nope", undefined), /未定義の project/);
  await sup.shutdown();
});

test("memory 無しの session は従来どおり: mcp-config は bantou-messenger と bantou だけ、env に BANTOU_MEMORY_TOKEN が無く、system-instructions は role + availability のみ（memory@1 は label にも文面にも出ない）", async () => {
  const { sup } = make({ realSystem: true });
  const st = await sup.start("pm1");
  const l = launches[0];
  assert.deepEqual(Object.keys(mcpOf(l.args).mcpServers), ["bantou-messenger", "bantou"]);
  assert.equal(valueOf(l.args, "--mcp-config"), mcpConfigJson("http://127.0.0.1:4567/mcp/session", "pm1"));
  assert.equal(l.env.BANTOU_MEMORY_TOKEN, undefined);
  assert.deepEqual(st.systemInstructions, ["master-cap-role@3", "master-cap-availability@1"]);
  assert.equal(valueOf(l.args, "--append-system-prompt"), buildSystemInstructions({ session: "pm1" }));
  assert.ok(!valueOf(l.args, "--append-system-prompt")!.includes("mcp__memory__"));
  await sup.shutdown();
});

test("memory あり: system-instructions に memory@1 が付く（文面は --append-system-prompt の先頭の部品群の末尾、label は status に出る）。利用者の指示はその後ろ", async () => {
  const { sup } = make({ realSystem: true, instructions: "利用者の指示", memory: { url: "http://m/mcp" } });
  const st = await sup.start("pm1");
  assert.deepEqual(st.systemInstructions, ["master-cap-role@3", "master-cap-availability@1", "memory@1"]);
  const v = valueOf(launches[0].args, "--append-system-prompt")!;
  assert.equal(v, `${buildSystemInstructions({ session: "pm1", memory: true })}\n\n利用者の指示`);
  assert.equal(st.instructions, true); // 利用者の指示だけを数える
  await sup.shutdown();
});

test("permissions.allow: 窓口あり = messenger + bantou（docs の mcp__<server>__* 形）。memory 無しなら mcp__memory は入らない。hooks / statusLine / outputStyle は不変", async () => {
  const path = join(dir, "pm1");
  await mkdir(path, { recursive: true });
  const { sup } = make({ outputStyle: "Be brief.", path });
  await sup.start("pm1");
  const s = JSON.parse(valueOf(launches[0].args, "--settings")!) as Record<string, unknown>;
  assert.deepEqual(s.permissions, { allow: ["mcp__bantou-messenger__*", "mcp__bantou__*"] });
  assert.equal(s.outputStyle, "bantou");
  assert.deepEqual(Object.keys(s).sort(), ["hooks", "outputStyle", "permissions", "statusLine"]);
  // 許可する server 名は --mcp-config の entry 名と一致する
  const servers = Object.keys(mcpOf(launches[0].args).mcpServers);
  for (const r of (s.permissions as { allow: string[] }).allow) assert.ok(servers.includes(r.replace(/^mcp__/, "").replace(/__\*$/, "")));
  assert.ok(!JSON.stringify(s.permissions).includes("memory"));
  await sup.shutdown();
});

test("permissions.allow: memory あり = mcp__memory__* も入る。deny は一切書かない", async () => {
  const { sup } = make({ memory: { url: "http://m/mcp" } });
  await sup.start("pm1");
  const s = JSON.parse(valueOf(launches[0].args, "--settings")!) as { permissions: Record<string, string[]> };
  assert.deepEqual(s.permissions, { allow: ["mcp__bantou-messenger__*", "mcp__bantou__*", "mcp__memory__*"] });
  assert.equal(s.permissions.deny, undefined);
  await sup.shutdown();
});

test("permissions.allow: bantouAllowRules の組み合わせ", () => {
  assert.deepEqual(bantouAllowRules({ bantou: false, memory: false }), ["mcp__bantou-messenger__*"]);
  assert.deepEqual(bantouAllowRules({ bantou: true, memory: true }), ["mcp__bantou-messenger__*", "mcp__bantou__*", "mcp__memory__*"]);
});
