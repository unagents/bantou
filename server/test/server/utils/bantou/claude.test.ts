import { test } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
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
    "--session-id", "sid-1", "--", "do it",
  ]);
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
      "--allowedTools", "Bash", "Read", "--disallowedTools", "Edit", "--model", "m",
      "--resume", "sid-1", "--", "do it",
    ],
  );
});

test("claude: injectArgs は session-id / resume の後ろ、-- の前", () => {
  const inject = ["--mcp-config", "{}", "--strict-mcp-config"];
  assert.deepEqual(buildClaudeArgs({ ...base, injectArgs: inject }), [
    "-p", "--output-format", "stream-json", "--verbose", "--permission-mode", "auto",
    "--session-id", "sid-1", ...inject, "--", "do it",
  ]);
  const r = buildClaudeArgs({ ...base, mode: "resume", injectArgs: inject });
  assert.ok(r.indexOf("--resume") < r.indexOf("--mcp-config"));
  assert.ok(r.indexOf("--mcp-config") < r.indexOf("--"));
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
