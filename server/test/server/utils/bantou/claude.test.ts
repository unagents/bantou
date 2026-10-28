import { test } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { matchesSession } from "../../../../server/utils/bantou/processes";
import {
  BASH_SANDBOX_OFF_SETTINGS,
  buildClaudeArgs,
  readResultEnvelope,
  runClaude,
  type ClaudeRunOptions,
} from "../../../../server/utils/bantou/claude";

const base: ClaudeRunOptions = {
  claude: "claude",
  sessionId: "sid-1",
  mode: "new",
  prompt: "do it",
  cwd: ".",
  permissionMode: "auto",
  allowedTools: [],
  disallowedTools: [],
  extraArgs: [],
  timeoutMs: 5000,
};

test("claude: buildClaudeArgs new（ツール指定なし）", () => {
  assert.deepEqual(buildClaudeArgs(base), [
    "-p", "--output-format", "stream-json", "--verbose", "--permission-mode", "auto",
    "--settings", "{\"sandbox\":{\"enabled\":false}}",
    "--session-id", "sid-1", "--", "do it",
  ]);
});

test("claude: capBashSandbox true は --settings を付けない（new / resume）", () => {
  for (const mode of ["new", "resume"] as const) {
    const args = buildClaudeArgs({ ...base, mode, capBashSandbox: true });
    assert.equal(args.includes("--settings"), false);
  }
});

test("claude: --settings は new / resume とも既定で付き、id と -- の前・値は 1 つ", () => {
  for (const mode of ["new", "resume"] as const) {
    const args = buildClaudeArgs({ ...base, mode, allowedTools: ["Bash"], extraArgs: ["--model", "m"] });
    const i = args.indexOf("--settings");
    assert.ok(i > 0);
    assert.equal(args[i + 1], BASH_SANDBOX_OFF_SETTINGS);
    assert.deepEqual(JSON.parse(args[i + 1]), { sandbox: { enabled: false } });
    assert.ok(i < args.indexOf(mode === "new" ? "--session-id" : "--resume"));
    assert.ok(i < args.indexOf("--"));
    // 値の直後は次のフラグ（extraArgs）で、可変長引数に飲まれない
    assert.equal(args[i + 2], "--model");
    // 孤児回収の argv 照合に影響しない
    assert.equal(matchesSession(["claude", ...args].join(" "), "sid-1"), true);
  }
});

test("claude: buildClaudeArgs resume + ツール + extraArgs", () => {
  assert.deepEqual(
    buildClaudeArgs({
      ...base,
      mode: "resume",
      allowedTools: ["Bash", "Read"],
      disallowedTools: ["Edit"],
      extraArgs: ["--model", "m"],
    }),
    [
      "-p", "--output-format", "stream-json", "--verbose", "--permission-mode", "auto",
      "--allowedTools", "Bash", "Read", "--disallowedTools", "Edit",
      "--settings", "{\"sandbox\":{\"enabled\":false}}", "--model", "m",
      "--resume", "sid-1", "--", "do it",
    ],
  );
});

test("claude: readResultEnvelope", () => {
  assert.deepEqual(
    readResultEnvelope('{"type":"result","subtype":"success","is_error":false,"session_id":"s","result":"hi"}'),
    { ok: true, sessionId: "s", resultText: "hi" },
  );
  assert.deepEqual(
    readResultEnvelope('{"type":"result","subtype":"success"}'),
    { ok: true, sessionId: null, resultText: "" },
  );
  assert.equal(readResultEnvelope('{"type":"result","subtype":"success","is_error":true}'), null);
  assert.equal(readResultEnvelope('{"type":"result","subtype":"error_max_turns"}'), null);
  assert.equal(readResultEnvelope('{"type":"assistant"}'), null);
  assert.equal(readResultEnvelope("not json"), null);
  assert.equal(readResultEnvelope("[]"), null);
});

async function withFake(script: string, fn: (exe: string, dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "bantou-claude-test-"));
  try {
    const exe = join(dir, "fake-claude");
    await writeFile(exe, `#!/usr/bin/env node\n${script}\n`);
    await chmod(exe, 0o755);
    await fn(exe, dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("runClaude: 成功（最終行に改行無し、ログ追記）", async () => {
  const script = `
process.stdout.write(JSON.stringify({type:"system"}) + "\\n");
process.stdout.write(JSON.stringify({type:"result",subtype:"success",is_error:false,session_id:"sid-1",result:"kicked"}));
`;
  await withFake(script, async (exe, dir) => {
    const logFile = join(dir, "logs", "sid-1.jsonl");
    const r = await runClaude({ ...base, claude: exe, cwd: dir, logFile });
    assert.ok(r.ok);
    if (r.ok) {
      assert.equal(r.resultText, "kicked");
      assert.equal(r.sessionId, "sid-1");
    }
    const text = await readFile(logFile, "utf8");
    const lines = text.trim().split("\n");
    assert.match(lines[0], /^# \d{4}-.*mode=new session=sid-1$/);
    assert.equal(lines.length, 3);
  });
});

test("runClaude: env が子プロセスに渡る", async () => {
  const script = `
process.stdout.write(JSON.stringify({type:"result",subtype:"success",is_error:false,session_id:"sid-1",result:process.env.BANTOU_TEST_X}));
`;
  await withFake(script, async (exe, dir) => {
    const r = await runClaude({ ...base, claude: exe, cwd: dir, env: { ...process.env, BANTOU_TEST_X: "hello" } });
    assert.ok(r.ok);
    if (r.ok) assert.equal(r.resultText, "hello");
  });
});

test("runClaude: 非ゼロ終了は stderr を detail にする", async () => {
  await withFake(`console.error("boom"); process.exit(3);`, async (exe, dir) => {
    const r = await runClaude({ ...base, claude: exe, cwd: dir });
    assert.ok(!r.ok);
    if (!r.ok) {
      assert.equal(r.detail, "boom");
      assert.equal(r.sessionMissing, false);
      assert.equal(r.timedOut, false);
    }
  });
});

test("runClaude: stderr 無しの非ゼロ終了は終了コード", async () => {
  await withFake(`process.exit(2);`, async (exe, dir) => {
    const r = await runClaude({ ...base, claude: exe, cwd: dir });
    assert.ok(!r.ok);
    if (!r.ok) assert.equal(r.detail, "終了コード 2");
  });
});

test("runClaude: タイムアウト", async () => {
  await withFake(`setTimeout(() => {}, 60000);`, async (exe, dir) => {
    const r = await runClaude({ ...base, claude: exe, cwd: dir, timeoutMs: 200 });
    assert.ok(!r.ok);
    if (!r.ok) {
      assert.equal(r.timedOut, true);
      assert.equal(r.detail, "タイムアウト (200ms)");
    }
  });
});

test("runClaude: session 無しを sessionMissing として返す", async () => {
  await withFake(`console.error("No conversation found with session ID: x"); process.exit(1);`, async (exe, dir) => {
    const r = await runClaude({ ...base, claude: exe, cwd: dir, mode: "resume" });
    assert.ok(!r.ok);
    if (!r.ok) assert.equal(r.sessionMissing, true);
  });
});

test("runClaude: 成功として読めない応答は失敗", async () => {
  await withFake(`console.log(JSON.stringify({type:"result",subtype:"success",is_error:true}));`, async (exe, dir) => {
    const r = await runClaude({ ...base, claude: exe, cwd: dir });
    assert.ok(!r.ok);
    if (!r.ok) assert.equal(r.detail, "応答が成功として読み取れない");
  });
});

test("runClaude: 起動できない実行ファイルは reject せず失敗", async () => {
  const r = await runClaude({ ...base, claude: "/nonexistent/claude-xyz" });
  assert.ok(!r.ok);
  if (!r.ok) assert.match(r.detail, /^claude を起動できない/);
});

test("killGroup: pid 無しの子は child.kill に落ちる。実プロセスは process group ごと止める", async () => {
  const { killGroup } = await import("../../../../server/utils/bantou/claude");
  const sent: string[] = [];
  killGroup({ pid: undefined, kill: (s?: NodeJS.Signals | number) => (sent.push(String(s)), true) }, "SIGTERM");
  assert.deepEqual(sent, ["SIGTERM"]);

  // sh が孫の sleep を起動する。detached（setsid）で起動し group kill で孫まで消えることを確認する
  const { spawn } = await import("node:child_process");
  const sh = spawn("sh", ["-c", "sleep 30 & echo $!; wait"], { detached: true, stdio: ["ignore", "pipe", "ignore"] });
  const grand = await new Promise<number>((res) => sh.stdout.once("data", (d: Buffer) => res(Number(String(d).trim()))));
  process.kill(grand, 0); // 生きている
  const closed = new Promise<void>((r) => sh.once("close", () => r()));
  killGroup(sh, "SIGKILL");
  await closed;
  await new Promise((r) => setTimeout(r, 100));
  assert.throws(() => process.kill(grand, 0), /ESRCH/);
});
