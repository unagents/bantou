import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { afterEach, beforeEach, test } from "node:test";
import { parseConfig, type Config } from "../src/config.js";
import {
  buildRcArgs,
  createRemoteControlSupervisor,
  detectConnected,
  extractUrls,
  mergeChildEnv,
  type ChildLike,
  type SpawnImpl,
} from "../src/remote-control.js";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
async function until(fn: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error("until: タイムアウト");
    await sleep(10);
  }
}

class FakeChild extends EventEmitter implements ChildLike {
  pid: number | undefined = 1000 + Math.floor(Math.random() * 1000);
  stdout = new PassThrough();
  stderr = new PassThrough();
  stdinData: string[] = [];
  stdin: Writable = new Writable({
    write: (chunk, _enc, cb) => {
      this.stdinData.push(String(chunk));
      cb();
    },
  });
  signals: string[] = [];
  /** SIGTERM で終了するか。 */
  exitOnTerm = true;
  kill(sig: NodeJS.Signals | number = "SIGTERM"): boolean {
    this.signals.push(String(sig));
    if (this.ignoreKill) return true;
    if (sig === "SIGKILL" || this.exitOnTerm) setImmediate(() => this.exitNow(null, sig));
    return true;
  }
  /** kill を全て無視する。 */
  ignoreKill = false;
  /** exit の後に stdout / stderr を閉じて close（実 child と同じ順）。 */
  exitNow(code: number | null, sig: NodeJS.Signals | number | null): void {
    this.emit("exit", code, sig);
    this.stdout.end();
    this.stderr.end();
    setImmediate(() => this.emit("close", code, sig));
  }
  die(code: number): void {
    this.exitNow(code, null);
  }
}

let dir: string;
let cfg: Config;
let children: { args: string[]; cwd: string; env: NodeJS.ProcessEnv; child: FakeChild }[];
let spawnImpl: SpawnImpl;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "center-rc-"));
  cfg = parseConfig(
    {
      projects: [{ name: "p1", path: "/tmp/p1" }],
      remoteControl: { claude: "fake-claude", restartDelayMs: 30, maxRestarts: 2, stopGraceMs: 80 },
      logDir: join(dir, "logs"),
    },
    join(dir, "c.json"),
  );
  children = [];
  spawnImpl = (_cmd, args, o) => {
    const child = new FakeChild();
    children.push({ args, cwd: o.cwd, env: o.env, child });
    return child;
  };
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const make = (): ReturnType<typeof createRemoteControlSupervisor> =>
  createRemoteControlSupervisor({ config: cfg, log: () => {}, spawnImpl });

test("buildRcArgs: same-dir / 未指定は --spawn / --capacity を付けず --continue を許す", () => {
  const p = cfg.projects[0];
  assert.equal(p.spawn, "same-dir");
  assert.deepEqual(buildRcArgs(p, cfg.remoteControl, { continue: false }), [
    "remote-control", "--name", "p1", "--permission-mode", "auto",
  ]);
  assert.deepEqual(buildRcArgs(p, cfg.remoteControl, { continue: true }), [
    "remote-control", "--name", "p1", "--permission-mode", "auto", "--continue",
  ]);
  const u = { ...p, spawn: undefined } as unknown as typeof p;
  assert.deepEqual(buildRcArgs(u, cfg.remoteControl, { continue: true }), [
    "remote-control", "--name", "p1", "--permission-mode", "auto", "--continue",
  ]);
});

test("buildRcArgs: worktree / session / capacity 指定は --spawn / --capacity を付け --continue を付けない", () => {
  const p = cfg.projects[0];
  const w = { ...p, spawn: "worktree" as const, permissionMode: "plan" as const };
  assert.deepEqual(buildRcArgs(w, cfg.remoteControl, { continue: true }), [
    "remote-control", "--name", "p1", "--spawn", "worktree", "--permission-mode", "plan",
  ]);
  const s = { ...p, spawn: "session" as const };
  assert.deepEqual(buildRcArgs(s, cfg.remoteControl, { continue: true }), [
    "remote-control", "--name", "p1", "--spawn", "session", "--permission-mode", "auto",
  ]);
  const c = { ...p, capacity: 2 };
  for (const cont of [true, false]) {
    assert.deepEqual(buildRcArgs(c, cfg.remoteControl, { continue: cont }), [
      "remote-control", "--name", "p1", "--spawn", "same-dir", "--permission-mode", "auto", "--capacity", "2",
    ]);
  }
});

test("extractUrls / detectConnected", () => {
  assert.deepEqual(extractUrls("Open https://claude.ai/code/session_01AbC-d_e now"), {
    sessionUrl: "https://claude.ai/code/session_01AbC-d_e",
  });
  assert.deepEqual(extractUrls("env: https://claude.ai/code?environment=env_01xyz"), {
    environmentUrl: "https://claude.ai/code?environment=env_01xyz",
  });
  assert.deepEqual(extractUrls("nothing here https://example.com/"), {});
  assert.equal(detectConnected("Remote Control: Connected"), true);
  assert.equal(detectConnected("Disconnected"), false);
  assert.equal(detectConnected("connecting..."), false);
});

test("start: starting -> Connected 行で connected、URL を取る、ログに追記", async () => {
  process.env.ANTHROPIC_API_KEY = "x";
  process.env.TMUX = "y";
  const sup = make();
  const s = await sup.start("p1");
  assert.equal(s.state, "starting");
  assert.equal(children.length, 1);
  assert.equal(children[0].cwd, "/tmp/p1");
  assert.equal(children[0].env.ANTHROPIC_API_KEY, undefined);
  assert.equal(children[0].env.TMUX, undefined);
  assert.equal(children[0].args[0], "remote-control");
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.TMUX;

  const c = children[0].child;
  c.stdout.write("hello\nSession https://claude.ai/code/session_abc123\n");
  c.stdout.write("https://claude.ai/code?environment=env_def456\nConnected\n");
  await until(() => sup.status("p1").state === "connected");
  const st = sup.status("p1");
  assert.equal(st.sessionUrl, "https://claude.ai/code/session_abc123");
  assert.equal(st.environmentUrl, "https://claude.ai/code?environment=env_def456");
  assert.equal(st.pid, c.pid);

  // 冪等
  await sup.start("p1");
  assert.equal(children.length, 1);

  await sup.stop("p1");
  // ログ stream の flush は非同期なので出るまで待つ
  let logText = "";
  await until(() => {
    try {
      logText = readFileSync(join(cfg.logDir, "p1.log"), "utf8");
    } catch {
      return false;
    }
    return /Connected/.test(logText);
  });
});

test("未定義 project は例外", async () => {
  const sup = make();
  await assert.rejects(sup.start("nope"), /未定義の project/);
  assert.throws(() => sup.status("nope"), /未定義の project/);
});

test("異常終了で --continue 付き再起動、上限超過で error", async () => {
  const sup = make();
  await sup.start("p1");
  children[0].child.die(3);
  await until(() => children.length === 2);
  assert.ok(!children[0].args.includes("--continue"));
  assert.ok(children[1].args.includes("--continue"));
  let st = sup.status("p1");
  assert.equal(st.restarts, 1);
  assert.equal(st.state, "starting");
  assert.deepEqual(st.lastExit && { code: st.lastExit.code, signal: st.lastExit.signal }, { code: 3, signal: null });

  children[1].child.die(1);
  await until(() => children.length === 3);
  assert.equal(sup.status("p1").restarts, 2);

  children[2].child.die(1);
  await until(() => sup.status("p1").state === "error");
  st = sup.status("p1");
  assert.equal(st.lastError, "再起動回数の上限");
  assert.equal(children.length, 3);
  await sup.shutdown();
});

test("stop: SIGTERM で stopped、再起動しない", async () => {
  const sup = make();
  await sup.start("p1");
  const st = await sup.stop("p1");
  assert.equal(st.state, "stopped");
  assert.deepEqual(children[0].child.signals, ["SIGTERM"]);
  await sleep(100);
  assert.equal(children.length, 1);
  assert.equal(sup.status("p1").state, "stopped");
  assert.equal(sup.status("p1").restarts, 0);
});

test("stop: SIGTERM で死なない子は grace 後に SIGKILL", async () => {
  const sup = make();
  await sup.start("p1");
  children[0].child.exitOnTerm = false;
  const st = await sup.stop("p1");
  assert.equal(st.state, "stopped");
  assert.deepEqual(children[0].child.signals, ["SIGTERM", "SIGKILL"]);
});

test("再起動待ちの stop でタイマーが取り消される", async () => {
  cfg.remoteControl.restartDelayMs = 200;
  const sup = make();
  await sup.start("p1");
  children[0].child.die(1);
  assert.equal(sup.status("p1").state, "starting");
  assert.equal(sup.status("p1").pid, null);
  const st = await sup.stop("p1");
  assert.equal(st.state, "stopped");
  await sleep(300);
  assert.equal(children.length, 1);
});

test("stop 後の start は --continue 無しで新規起動、restarts は 0", async () => {
  const sup = make();
  await sup.start("p1");
  await sup.stop("p1");
  await sup.start("p1");
  assert.equal(children.length, 2);
  assert.ok(!children[1].args.includes("--continue"));
  await sup.shutdown();
});

test("spawn の error イベントで error 状態", async () => {
  const sup = make();
  await sup.start("p1");
  children[0].child.pid = undefined; // spawn 失敗では pid が無い
  children[0].child.emit("error", new Error("ENOENT"));
  const st = sup.status("p1");
  assert.equal(st.state, "error");
  assert.match(st.lastError ?? "", /ENOENT/);
  await sleep(80);
  assert.equal(children.length, 1);
});

test("spawn が同期例外でも error 状態", async () => {
  spawnImpl = () => {
    throw new Error("boom");
  };
  const sup = make();
  const st = await sup.start("p1");
  assert.equal(st.state, "error");
  assert.match(st.lastError ?? "", /boom/);
});

test("shutdown は全 project を停止", async () => {
  cfg = parseConfig(
    {
      projects: [{ name: "a", path: "/tmp/a" }, { name: "b", path: "/tmp/b" }],
      remoteControl: { stopGraceMs: 80 },
      logDir: join(dir, "logs"),
    },
    join(dir, "c.json"),
  );
  const sup = make();
  await sup.start("a");
  await sup.start("b");
  await sup.shutdown();
  assert.deepEqual(sup.list().map((s) => s.state), ["stopped", "stopped"]);
});

test("有効化確認のプロンプトに y\\n を一度だけ返し、stdin は閉じない", async () => {
  const sup = make();
  await sup.start("p1");
  const c = children[0].child;
  c.stdout.write("Enable Remote Con");
  c.stdout.write("trol? (y/n)");
  await until(() => c.stdinData.length === 1);
  assert.deepEqual(c.stdinData, ["y\n"]);
  c.stdout.write("Enable Remote Control? (y/n)\nConnected\n");
  await until(() => sup.status("p1").state === "connected");
  assert.deepEqual(c.stdinData, ["y\n"]);
  assert.equal(c.stdin.writableEnded, false);
  await sup.shutdown();
});

test("autoConsent: false なら y を送らない", async () => {
  cfg.remoteControl.autoConsent = false;
  const sup = make();
  await sup.start("p1");
  const c = children[0].child;
  c.stdout.write("Enable Remote Control? (y/n)");
  await sleep(50);
  assert.deepEqual(c.stdinData, []);
  await sup.shutdown();
});

test("exit 後に届いた出力もログに残り、改行なしの最終行も解釈する", async () => {
  const sup = make();
  await sup.start("p1");
  const c = children[0].child;
  c.emit("exit", 0, null);
  // exit の後、close の前に残りの出力が届く
  c.stdout.write("tail line\n");
  c.stdout.write("Connected");
  c.stdout.end();
  c.stderr.end();
  setImmediate(() => c.emit("close"));
  let logText = "";
  await until(() => {
    try {
      logText = readFileSync(join(cfg.logDir, "p1.log"), "utf8");
    } catch {
      return false;
    }
    return /tail line\nConnected/.test(logText);
  });
  await sup.shutdown();
});

test("exit だけで close が来なくてもログ stream は閉じる（孫が pipe を握る場合）", async () => {
  const sup = make();
  await sup.start("p1");
  const c = children[0].child;
  c.emit("exit", 0, null);
  await until(() => sup.status("p1").lastExit !== null);
  assert.equal(sup.status("p1").pid, null);
  await sup.shutdown();
});

test("古い世代の child の exit は現在の entry を壊さず、再起動もしない", async () => {
  const sup = make();
  await sup.start("p1");
  const old = children[0].child;
  old.ignoreKill = true;
  await sup.stop("p1"); // grace + SIGKILL 待ちの後、死なない child を残したまま諦める
  assert.equal(sup.status("p1").state, "stopped");
  await sup.start("p1");
  assert.equal(children.length, 2);
  const cur = children[1].child;
  cur.stdout.write("Connected\n");
  await until(() => sup.status("p1").state === "connected");
  old.die(9);
  await sleep(120);
  const st = sup.status("p1");
  assert.equal(children.length, 2);
  assert.equal(st.state, "connected");
  assert.equal(st.pid, cur.pid);
  assert.equal(st.restarts, 0);
  assert.equal(st.lastExit, null);
  await sup.shutdown();
});

test("start の mkdir 待ち中に stop されたら起動しない", async () => {
  const sup = make();
  const p = sup.start("p1");
  const q = sup.stop("p1");
  const st = await p;
  await q;
  assert.equal(children.length, 0);
  assert.equal(st.state, "stopped");
});

test("shutdown 後の start は起動しない", async () => {
  const sup = make();
  await sup.shutdown();
  const st = await sup.start("p1");
  assert.equal(children.length, 0);
  assert.equal(st.state, "stopped");
});

test("起動済みの child の error では追跡を続ける", async () => {
  const sup = make();
  await sup.start("p1");
  const c = children[0].child;
  c.emit("error", new Error("kill failed"));
  const st = sup.status("p1");
  assert.equal(st.state, "starting");
  assert.equal(st.pid, c.pid);
  assert.equal(st.lastError, undefined);
  c.die(0);
  await sup.stop("p1");
});

test("mergeChildEnv: base < remoteControl.env < project.env、API キーと TMUX は常に除く", () => {
  const env = mergeChildEnv(
    { A: "base", B: "base", C: "base", ANTHROPIC_API_KEY: "k", TMUX: "t" },
    { B: "rc", C: "rc", D: "rc", ANTHROPIC_API_KEY: "inj", TMUX: "inj" },
    { C: "proj", E: "proj" },
  );
  assert.deepEqual(env, { A: "base", B: "rc", C: "proj", D: "rc", E: "proj" });
});

test("子プロセスには remoteControl.env と project.env が合成されて渡る", async () => {
  cfg = parseConfig(
    {
      projects: [{ name: "p1", path: "/tmp/p1", env: { X: "proj", Y: "proj" } }],
      remoteControl: { claude: "fake-claude", env: { X: "rc", Z: "rc", TMUX: "inj" } },
      logDir: join(dir, "logs"),
    },
    join(dir, "c.json"),
  );
  const sup = make();
  await sup.start("p1");
  assert.equal(children[0].env.X, "proj");
  assert.equal(children[0].env.Y, "proj");
  assert.equal(children[0].env.Z, "rc");
  assert.equal(children[0].env.TMUX, undefined);
  await sup.shutdown();
});

test("start: launch の前に reap を 1 回呼ぶ（再起動では呼ばない）", async () => {
  const order: string[] = [];
  const sup = createRemoteControlSupervisor({
    config: cfg,
    log: () => {},
    spawnImpl: (c, a, o) => {
      order.push("spawn");
      return spawnImpl(c, a, o);
    },
    reap: async (p) => {
      order.push(`reap:${p}`);
    },
  });
  await sup.start("p1");
  assert.deepEqual(order, ["reap:p1", "spawn"]);
  children[0].child.die(1);
  await until(() => children.length === 2);
  assert.deepEqual(order, ["reap:p1", "spawn", "spawn"]);
  await sup.shutdown();
});

test("start: reap が失敗しても起動する", async () => {
  const sup = createRemoteControlSupervisor({
    config: cfg,
    log: () => {},
    spawnImpl,
    reap: async () => {
      throw new Error("boom");
    },
  });
  await sup.start("p1");
  assert.equal(children.length, 1);
  await sup.shutdown();
});

test("spawn は detached: true で呼ぶ", async () => {
  let detached: boolean | undefined;
  const sup = createRemoteControlSupervisor({
    config: cfg,
    log: () => {},
    spawnImpl: (c, a, o) => {
      detached = o.detached;
      return spawnImpl(c, a, o);
    },
  });
  await sup.start("p1");
  assert.equal(detached, true);
  await sup.shutdown();
});

test("killAllSync は killImpl を通して生きている子へ送る", async () => {
  const sent: string[] = [];
  const sup = createRemoteControlSupervisor({
    config: cfg,
    log: () => {},
    spawnImpl,
    killImpl: (c, sig) => {
      sent.push(sig);
      c.kill(sig);
    },
  });
  await sup.start("p1");
  sup.killAllSync("SIGKILL");
  assert.deepEqual(sent, ["SIGKILL"]);
  await sup.shutdown();
  // 子が居なくなった後は何も送らない
  const n = sent.length;
  sup.killAllSync("SIGKILL");
  assert.equal(sent.length, n);
  assert.equal(sent[0], "SIGKILL");
});

test("stop: SIGTERM で終わらなければ killImpl に SIGKILL を送る", async () => {
  const sent: string[] = [];
  const sup = createRemoteControlSupervisor({
    config: cfg,
    log: () => {},
    spawnImpl,
    killImpl: (c, sig) => {
      sent.push(sig);
      c.kill(sig);
    },
  });
  await sup.start("p1");
  children[0].child.exitOnTerm = false;
  await sup.stop("p1");
  assert.deepEqual(sent, ["SIGTERM", "SIGKILL"]);
  await sup.shutdown();
});

test("add / remove: 実行中に project を足して起動でき、remove で止めて外す。config 由来は外せない", async () => {
  const sup = make();
  sup.add({ name: "dyn", path: "/tmp/dyn", spawn: "same-dir", permissionMode: "plan", autostart: false });
  assert.throws(() => sup.add({ name: "dyn", path: "/tmp/x", spawn: "same-dir", permissionMode: "auto", autostart: false }), /既に存在/);
  assert.throws(() => sup.add({ name: "p1", path: "/tmp/x", spawn: "same-dir", permissionMode: "auto", autostart: false }), /既に存在/);
  assert.deepEqual(sup.list().map((s) => s.project), ["p1", "dyn"]);
  await sup.start("dyn");
  assert.deepEqual(children[0].args, ["remote-control", "--name", "dyn", "--permission-mode", "plan"]);
  assert.equal(children[0].cwd, "/tmp/dyn");
  await assert.rejects(sup.remove("p1"), /config 由来/);
  await sup.remove("dyn");
  assert.deepEqual(children[0].child.signals, ["SIGTERM"]);
  assert.deepEqual(sup.list().map((s) => s.project), ["p1"]);
  assert.throws(() => sup.status("dyn"), /未定義/);
  await sup.shutdown();
});

test("start resume: --continue で起動し、接続前の早期終了なら素の起動へ fallback（再起動回数は増えない）", async () => {
  const sup = make();
  await sup.start("p1", { resume: true });
  assert.ok(children[0].args.includes("--continue"));
  children[0].child.die(1);
  await until(() => children.length === 2);
  assert.ok(!children[1].args.includes("--continue"));
  assert.equal(sup.status("p1").restarts, 0);
  assert.equal(sup.status("p1").state, "starting");
  await sup.shutdown();
});

test("start resume: 接続後の終了は fallback せず通常の再起動（--continue のまま）", async () => {
  const sup = make();
  await sup.start("p1", { resume: true });
  children[0].child.stdout.write("Remote Control: Connected\n");
  await until(() => sup.status("p1").state === "connected");
  children[0].child.die(1);
  await until(() => children.length === 2);
  assert.ok(children[1].args.includes("--continue"));
  assert.equal(sup.status("p1").restarts, 1);
  await sup.shutdown();
});

test("start（resume 無し）: 早期終了でも fallback ではなく通常の再起動予約", async () => {
  const sup = make();
  await sup.start("p1");
  assert.ok(!children[0].args.includes("--continue"));
  children[0].child.die(1);
  await until(() => children.length === 2);
  assert.equal(sup.status("p1").restarts, 1);
  await sup.shutdown();
});

test("接続前に終了したら直近の出力を lastError に残し、再起動上限でも原因が見える", async () => {
  cfg = parseConfig(
    { projects: [{ name: "p1", path: "/tmp/p1" }], remoteControl: { claude: "fake-claude", restartDelayMs: 10, maxRestarts: 1, stopGraceMs: 80 }, logDir: join(dir, "logs") },
    join(dir, "c.json"),
  );
  const sup = make();
  await sup.start("p1");
  children[0].child.stderr.write("Error: Workspace not trusted. Please run `claude` in /x first\n");
  await sleep(10);
  children[0].child.die(1);
  await until(() => sup.status("p1").lastExit !== null);
  assert.match(sup.status("p1").lastError ?? "", /^接続前に終了: Error: Workspace not trusted/);
  await until(() => children.length === 2);
  children[1].child.stderr.write("Error: Workspace not trusted. again\n");
  await sleep(10);
  children[1].child.die(1);
  await until(() => sup.status("p1").state === "error");
  assert.match(sup.status("p1").lastError ?? "", /^再起動回数の上限（接続前に終了: Error: Workspace not trusted\. again）$/);
  await sup.shutdown();
});

test("接続後の終了は lastError を付けない", async () => {
  const sup = make();
  await sup.start("p1");
  children[0].child.stdout.write("Remote Control: Connected\n");
  await until(() => sup.status("p1").state === "connected");
  children[0].child.die(1);
  await until(() => sup.status("p1").lastExit !== null);
  assert.equal(sup.status("p1").lastError, undefined);
  await sup.shutdown();
});
