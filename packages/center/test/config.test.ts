import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadConfig, parseConfig } from "../src/config.js";

const P = "/tmp/proj";

test("最小 config に既定値が入る", () => {
  const c = parseConfig({ projects: [{ name: "a", path: P }] }, "/etc/bantou/center.json");
  assert.deepEqual(c.projects[0], { name: "a", path: P, spawn: "same-dir", permissionMode: "auto", autostart: false });
  assert.deepEqual(c.remoteControl, {
    claude: "claude",
    continueOnRestart: true,
    autoConsent: true,
    restartDelayMs: 5000,
    maxRestarts: 5,
    stopGraceMs: 5000,
  });
  assert.deepEqual(c.servers, []);
  assert.equal(c.logDir, "/etc/bantou/center-logs");
});

test("空オブジェクトでも通る", () => {
  const c = parseConfig({}, "/x/c.json");
  assert.deepEqual(c.projects, []);
});

test("全項目指定", () => {
  const c = parseConfig(
    {
      projects: [{ name: "a-1", path: P, spawn: "worktree", permissionMode: "plan", capacity: 3, autostart: true }],
      remoteControl: { claude: "/bin/c", continueOnRestart: false, autoConsent: false, restartDelayMs: 0, maxRestarts: 0, stopGraceMs: 10 },
      servers: [{ name: "s_1", broker: "http://h:7901", token: "t", timeoutMs: 1000 }],
      logDir: "/var/log/x",
    },
    "/x/c.json",
  );
  assert.equal(c.projects[0].capacity, 3);
  assert.equal(c.remoteControl.claude, "/bin/c");
  assert.equal(c.remoteControl.autoConsent, false);
  assert.equal(c.servers[0].timeoutMs, 1000);
  assert.equal(c.servers[0].token, "t");
  assert.equal(c.logDir, "/var/log/x");
});

test("server の timeoutMs 既定は 35 分", () => {
  const c = parseConfig({ servers: [{ name: "s", broker: "http://127.0.0.1:1" }] }, "/x/c.json");
  assert.equal(c.servers[0].timeoutMs, 2_100_000);
});

const bad = (data: unknown, re: RegExp): void =>
  assert.throws(() => parseConfig(data, "/x/c.json"), (e: Error) => /^config が不正: /.test(e.message) && re.test(e.message));

test("不正な project 名", () => bad({ projects: [{ name: "a b", path: P }] }, /projects\.0\.name/));
test("相対 path は拒否", () => bad({ projects: [{ name: "a", path: "rel/x" }] }, /projects\.0\.path/));
test("project 名の重複", () =>
  bad({ projects: [{ name: "a", path: P }, { name: "a", path: P }] }, /名前が重複: a/));
test("server 名の重複", () =>
  bad(
    { servers: [{ name: "s", broker: "http://h:1" }, { name: "s", broker: "http://h:2" }] },
    /servers\.1\.name/,
  ));
test("broker が URL でない", () => bad({ servers: [{ name: "s", broker: "not a url" }] }, /servers\.0\.broker/));
test("broker が http でない", () => bad({ servers: [{ name: "s", broker: "ftp://h" }] }, /servers\.0\.broker/));
test("broker は https 不可", () => bad({ servers: [{ name: "s", broker: "https://h:7901" }] }, /servers\.0\.broker/));
test("broker の末尾 / は除く", () => {
  const c = parseConfig({ servers: [{ name: "s", broker: "http://h:7901/" }] }, "/x/c.json");
  assert.equal(c.servers[0].broker, "http://h:7901");
});
test("不正な permissionMode", () =>
  bad({ projects: [{ name: "a", path: P, permissionMode: "yolo" }] }, /projects\.0\.permissionMode/));
test("capacity は 1 以上", () => bad({ projects: [{ name: "a", path: P, capacity: 0 }] }, /capacity/));

test("loadConfig: 読めない / JSON 不正 / 正常", async () => {
  const dir = await mkdtemp(join(tmpdir(), "center-cfg-"));
  try {
    await assert.rejects(loadConfig(join(dir, "none.json")), /^Error: config を読めない: /);
    const f = join(dir, "c.json");
    await writeFile(f, "{oops");
    await assert.rejects(loadConfig(f), /config が JSON として不正/);
    await writeFile(f, JSON.stringify({ projects: [{ name: "a", path: P }] }));
    const c = await loadConfig(f);
    assert.equal(c.logDir, join(dir, "center-logs"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
