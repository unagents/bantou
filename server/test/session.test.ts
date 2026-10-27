import { test } from "node:test";
import assert from "node:assert/strict";
import { isValidSessionName, parseServerCommand } from "@agent-hand/bantou-protocol";
import { mkdtemp, mkdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveCwd, parseSessions, assertInsideRepos } from "../src/session.js";
import { ignoreText, brokerUrl, maskUserinfo } from "../src/daemon.js";

test("assertInsideRepos: symlink で repos 外へ出るものは拒否", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bantou-session-test-"));
  try {
    const repos = join(dir, "repos");
    const outside = join(dir, "outside");
    await mkdir(join(repos, "ok"), { recursive: true });
    await mkdir(outside);
    await symlink(outside, join(repos, "link"));
    await assertInsideRepos(repos, join(repos, "ok"));
    await assert.rejects(assertInsideRepos(repos, join(repos, "link")), /repos 配下のみ/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("maskUserinfo: URL の userinfo を伏せる", () => {
  assert.equal(
    maskUserinfo('{"repo":"https://u:p@github.com/o/r.git"}'),
    '{"repo":"https://***@github.com/o/r.git"}',
  );
  assert.equal(maskUserinfo('{"repo":"git@github.com:o/r.git"}'), '{"repo":"git@github.com:o/r.git"}');
});

test("resolveCwd: 省略時は <repos>/<name>", () => {
  assert.equal(resolveCwd("/ws/repos", "a"), "/ws/repos/a");
});

test("resolveCwd: repos 配下の相対パスは許可", () => {
  assert.equal(resolveCwd("/ws/repos", "a", "x"), "/ws/repos/x");
  assert.equal(resolveCwd("/ws/repos", "a", "x/y"), "/ws/repos/x/y");
});

test("resolveCwd: repos 外は拒否", () => {
  assert.throws(() => resolveCwd("/ws/repos", "a", "../x"), /repos 配下のみ/);
  assert.throws(() => resolveCwd("/ws/repos", "a", "/abs"), /repos 配下のみ/);
  assert.throws(() => resolveCwd("/ws/repos", "a", "../repos2"), /repos 配下のみ/);
});

test("isValidSessionName", () => {
  assert.ok(isValidSessionName("a-b_C9"));
  for (const n of ["", "a b", "a/b", "a.b", "a:b", 1, undefined]) {
    assert.ok(!isValidSessionName(n));
  }
});

test("parseServerCommand: launch / 非 JSON / task envelope", () => {
  const cmd = parseServerCommand(JSON.stringify({ bantou: 1, type: "launch_session", name: "s1" }));
  assert.equal(cmd?.type, "launch_session");
  assert.equal(parseServerCommand("hello"), undefined);
  assert.equal(
    parseServerCommand(JSON.stringify({ bantou: 1, type: "task", task_id: "t1" })),
    undefined,
  );
});

test("parseSessions: tmux 出力を変換", () => {
  const [s] = parseSessions("a\t2\t1700000000\t1\n");
  assert.deepEqual(s, {
    name: "a",
    windows: 2,
    created: new Date(1700000000 * 1000).toISOString(),
    attached: true,
  });
  assert.deepEqual(parseSessions(""), []);
});

test("ignoreText: 改行を潰し 120 文字で切る", () => {
  assert.equal(ignoreText("a\nb\n\nc"), "a b c");
  assert.equal(ignoreText("x".repeat(500)).length, 120);
});

test("brokerUrl: 全 IF bind は loopback", () => {
  assert.equal(brokerUrl("0.0.0.0", 7901), "http://127.0.0.1:7901");
  assert.equal(brokerUrl("::", 1), "http://[::1]:1");
  assert.equal(brokerUrl("10.0.0.5", 2), "http://10.0.0.5:2");
});
