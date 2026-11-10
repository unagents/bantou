import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isServerReply, type ServerCommand } from "@agent-hand/bantou-protocol";
import {
  EXIT_RETIRED,
  RETIRED_FILE,
  allowedWhileRetiring,
  buildHostSteps,
  createRetireController,
  detectService,
  retiringError,
  shQuote,
  writeRetiredMarker,
  type RetireDeps,
} from "../../../../server/utils/bantou/retire";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const identity = { server_id: "srv-0a1b2c3d4e", host: "lenovo", user: "bantou", workspace: "/home/bantou" };
const cmd = { bantou: 1 as const, type: "retire_server" as const };

function setup(over: Partial<RetireDeps> = {}) {
  const calls: string[] = [];
  const deps: RetireDeps = {
    workspace: "/home/bantou",
    identity,
    count: () => (calls.push("count"), { caps: 1, workers: 2 }),
    cancelUpdate: () => void calls.push("cancelUpdate"),
    refuse: () => void calls.push("refuse"),
    stopAll: async () => {
      calls.push("stopAll");
    },
    finish: () => void calls.push("finish"),
    service: () => ({ manager: "systemd", name: "bantou-server.service", detected: true }),
    platform: "linux",
    home: "/home/bantou",
    replyGraceMs: 40,
    finishDeadlineMs: 400,
    writeMarker: async () => void calls.push("marker"),
    log: () => {},
    ...over,
  };
  return { calls, deps, ctl: createRetireController(deps) };
}

test("retire: 順序は 印 → 受付停止（更新取消）→ 数える → 停止 → 返信 → 猶予 → finish。猶予の間は finish しない", async () => {
  const { calls, ctl } = setup();
  const reply = await ctl.request(cmd, "center(p1)");
  assert.deepEqual(calls, ["marker", "cancelUpdate", "refuse", "count", "stopAll"]);
  assert.ok(isServerReply(reply));
  assert.equal(reply.type, "retire_result");
  if (reply.type !== "retire_result") return;
  assert.deepEqual(reply.stopped, { caps: 1, workers: 2 });
  assert.equal(reply.exit_code, EXIT_RETIRED);
  assert.equal(reply.exit_code, 76);
  assert.equal(reply.server_id, "srv-0a1b2c3d4e");
  assert.ok(reply.host_steps.length >= 1 && reply.host_steps.length <= 3);
  assert.equal(ctl.isRetiring(), true);
  await sleep(10);
  assert.ok(!calls.includes("finish"), "返信を送り終える前に finish しない");
  ctl.replied();
  await sleep(10);
  assert.ok(!calls.includes("finish"), "猶予の間は finish しない");
  await sleep(80);
  assert.equal(calls.at(-1), "finish");
  assert.equal(calls.filter((c) => c === "finish").length, 1);
});

test("retire: 2 回目の retire_server は同じ返信（停止し直さない）。finish は 1 回", async () => {
  const { calls, ctl } = setup();
  const a = await ctl.request(cmd, "c");
  const b = await ctl.request(cmd, "c");
  assert.equal(a, b);
  assert.equal(calls.filter((c) => c === "stopAll").length, 1);
  ctl.replied();
  ctl.replied();
  await sleep(100);
  assert.equal(calls.filter((c) => c === "finish").length, 1);
});

test("retire: 同時に 2 つ来ても 1 回だけ実行する", async () => {
  const { calls, ctl } = setup({ stopAll: async () => void (await sleep(20)) });
  const [a, b] = await Promise.all([ctl.request(cmd, "c"), ctl.request(cmd, "c")]);
  assert.equal(a, b);
  assert.equal(calls.filter((c) => c === "marker").length, 1);
});

test("retire: server_id が違えば error で何も止めない（印も書かない）。形式不正も error", async () => {
  const { calls, ctl } = setup();
  const r = await ctl.request({ ...cmd, server_id: "srv-other" }, "c");
  assert.equal(r.type, "error");
  assert.equal((r as { command?: string }).command, "retire_server");
  assert.deepEqual(calls, []);
  assert.equal(ctl.isRetiring(), false);
  const bad = await ctl.request({ ...cmd, server_id: "a b" }, "c");
  assert.equal(bad.type, "error");
  assert.deepEqual(calls, []);
  // 一致すれば進む
  const ok = await ctl.request({ ...cmd, server_id: "srv-0a1b2c3d4e" }, "c");
  assert.equal(ok.type, "retire_result");
});

test("retire: 印を書けなければ error で何も止めない（server は動き続ける）", async () => {
  const { calls, ctl } = setup({ writeMarker: async () => { throw new Error("EACCES"); } });
  const r = await ctl.request(cmd, "c");
  assert.equal(r.type, "error");
  assert.match((r as { message: string }).message, /何も止めていない/);
  assert.equal(calls.length, 0);
  assert.equal(ctl.isRetiring(), false);
  ctl.replied();
  await sleep(80);
  assert.ok(!calls.includes("finish"));
});

test("retire: 停止・受付停止が失敗しても返信と finish まで進む（ゾンビにならない）", async () => {
  const { calls, ctl } = setup({
    stopAll: async () => { throw new Error("kill 失敗"); },
    refuse: () => { throw new Error("handler 失敗"); },
    count: () => { throw new Error("数えられない"); },
  });
  const r = await ctl.request(cmd, "c");
  assert.equal(r.type, "retire_result");
  assert.deepEqual((r as { stopped: unknown }).stopped, { caps: 0, workers: 0 });
  ctl.replied();
  await sleep(100);
  assert.ok(calls.includes("finish"));
});

test("retire: 返信を送り終えられなくても deadline で finish する（居座らない）", async () => {
  const { calls, ctl } = setup({ finishDeadlineMs: 60 });
  await ctl.request(cmd, "c");
  await sleep(20);
  assert.ok(!calls.includes("finish"));
  await sleep(100);
  assert.equal(calls.filter((c) => c === "finish").length, 1);
});

test("retire: stopAll が長くかかっても deadline で finish する", async () => {
  const { calls, ctl } = setup({ finishDeadlineMs: 50, stopAll: () => sleep(300) });
  const p = ctl.request(cmd, "c");
  await sleep(120);
  assert.ok(calls.includes("finish"), "停止が詰まっても終了へ進む");
  await p;
});

test("retiringError: 退役中と分かる message・retiring:true・retryable:false。cap_id / task_id / worker_id を引き継ぐ。protocol の guard を通る", () => {
  const cmds: ServerCommand[] = [
    { bantou: 1, type: "task", cap_id: "c1", task_id: "t1", goal: "g", deliverables: {}, verify: {}, constraints: [], workers: {} },
    { bantou: 1, type: "kick_cap", cap_id: "c1", prompt: "p" },
    { bantou: 1, type: "worker_reply", cap_id: "c1", worker_id: "w1", text: "x" },
    { bantou: 1, type: "update_server", version: "0.7.0" },
  ];
  for (const c of cmds) {
    const e = retiringError(c);
    assert.ok(isServerReply(e), c.type);
    assert.equal((e as { retiring?: boolean }).retiring, true);
    assert.equal((e as { retryable?: boolean }).retryable, false);
    assert.equal((e as { command?: string }).command, c.type);
    assert.match((e as { message: string }).message, /退役/);
  }
  assert.equal((retiringError(cmds[0]!) as { task_id?: string }).task_id, "t1");
  assert.equal((retiringError(cmds[2]!) as { worker_id?: string }).worker_id, "w1");
});

test("allowedWhileRetiring: 照会と停止だけ通し、task / kick_cap / worker_reply / update_server / resume_worker は断る", () => {
  const ok: ServerCommand[] = [{ bantou: 1, type: "hello" }, { bantou: 1, type: "status" }, { bantou: 1, type: "stop_cap", cap_id: "c" }, { bantou: 1, type: "retire_server" }];
  const ng: ServerCommand[] = [
    { bantou: 1, type: "kick_cap", cap_id: "c", prompt: "p" },
    { bantou: 1, type: "worker_reply", cap_id: "c", worker_id: "w", text: "t" },
    { bantou: 1, type: "update_server", version: "0.7.0" },
    { bantou: 1, type: "resume_worker", worker_id: "w", prompt: "p" },
  ];
  for (const c of ok) assert.equal(allowedWhileRetiring(c), true, c.type);
  for (const c of ng) assert.equal(allowedWhileRetiring(c), false, c.type);
});

test("shQuote: 単一引用符を含む値も 1 語として quote する", () => {
  assert.equal(shQuote("a b"), "'a b'");
  assert.equal(shQuote("it's"), `'it'\\''s'`);
  assert.equal(shQuote("$(rm -rf /)"), "'$(rm -rf /)'");
});

test("detectService: linux は INVOCATION_ID と cgroup の unit 名、取れなければ既定名（detected=false）、systemd 外は none", () => {
  assert.deepEqual(detectService({ platform: "linux", env: {} }), { manager: "none" });
  assert.deepEqual(
    detectService({ platform: "linux", env: { INVOCATION_ID: "x" }, cgroup: "0::/system.slice/bantou-server-b.service\n" }),
    { manager: "systemd", name: "bantou-server-b.service", detected: true },
  );
  assert.deepEqual(detectService({ platform: "linux", env: { INVOCATION_ID: "x" }, cgroup: "0::/user.slice/session-3.scope" }), {
    manager: "systemd",
    name: "bantou-server.service",
    detected: false,
  });
  assert.deepEqual(detectService({ platform: "darwin", env: { XPC_SERVICE_NAME: "com.unagents.bantou" } }), { manager: "launchd", name: "com.unagents.bantou", detected: true });
  assert.deepEqual(detectService({ platform: "darwin", env: { XPC_SERVICE_NAME: "0" } }), { manager: "none" });
  assert.deepEqual(detectService({ platform: "darwin", env: { XPC_SERVICE_NAME: "application.com.apple.Terminal.1" } }), { manager: "none" });
  assert.deepEqual(detectService({ platform: "darwin", env: {} }), { manager: "none" });
});

test("buildHostSteps: systemd は unit → user（-r。workspace が HOME 配下なら workspace 削除は含む）。値は quote。3 行以内", () => {
  const svc = { manager: "systemd" as const, name: "bantou-server.service", detected: true };
  const steps = buildHostSteps({ service: svc, platform: "linux", user: "bantou", home: "/home/bantou", workspace: "/home/bantou" });
  assert.equal(steps.length, 2);
  assert.match(steps[0]!, /^sudo systemctl disable --now 'bantou-server\.service' && sudo rm -f '\/etc\/systemd\/system\/bantou-server\.service' && sudo systemctl daemon-reload$/);
  assert.equal(steps[1], "sudo userdel -r 'bantou'");
  // workspace が HOME の外なら workspace の削除が別行
  const out = buildHostSteps({ service: svc, platform: "linux", user: "bantou", home: "/home/bantou", workspace: "/srv/bantou ws" });
  assert.equal(out.length, 3);
  assert.equal(out[1], "sudo userdel 'bantou'");
  assert.equal(out[2], "sudo rm -rf '/srv/bantou ws'");
  // 手起動: unit 行なし
  const none = buildHostSteps({ service: { manager: "none" }, platform: "linux", user: "bantou", home: "/home/bantou", workspace: "/home/bantou" });
  assert.deepEqual(none, ["sudo userdel -r 'bantou'"]);
});

test("buildHostSteps: root・不正な user 名は user 削除を出さない。短い workspace（/ や /x）は rm -rf を出さない。launchd は bootout と plist", () => {
  const svc = { manager: "none" as const };
  const r = buildHostSteps({ service: svc, platform: "linux", user: "root", home: "/root", workspace: "/root/ws" });
  assert.ok(r.every((s) => !s.includes("userdel")));
  assert.deepEqual(r, ["sudo rm -rf '/root/ws'"]);
  const s = buildHostSteps({ service: svc, platform: "linux", user: "a b", home: "/", workspace: "/" });
  assert.ok(s.every((x) => !x.includes("rm -rf '/'") && !x.includes("userdel")));
  assert.equal(s.length, 1);
  assert.ok(s[0]!.startsWith("#"));
  const mac = buildHostSteps({ service: { manager: "launchd", name: "com.unagents.bantou", detected: true }, platform: "darwin", user: "bantou", home: "/Users/bantou", workspace: "/Users/bantou" });
  assert.equal(mac[0], "sudo launchctl bootout 'system/com.unagents.bantou'; sudo rm -f '/Library/LaunchDaemons/com.unagents.bantou.plist'");
  assert.equal(mac[1], "sudo sysadminctl -deleteUser 'bantou'");
  assert.equal(mac[2], "sudo rm -rf '/Users/bantou'");
});

test("writeRetiredMarker: workspace に server.retired を JSON で置く（tmp が残らない）", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bantou-retire-test-"));
  try {
    await writeRetiredMarker(join(dir, "ws"), { retired_at: "2026-11-10T00:00:00.000Z", by: "center" });
    const body = JSON.parse(await readFile(join(dir, "ws", RETIRED_FILE), "utf8"));
    assert.equal(body.by, "center");
    const { readdir } = await import("node:fs/promises");
    assert.deepEqual(await readdir(join(dir, "ws")), [RETIRED_FILE]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("退役の印の名前と終了コードは bin/bantou.mjs・unit・plist・protocol と揃っている", async () => {
  const bin = readFileSync(fileURLToPath(new URL("../../../../bin/bantou.mjs", import.meta.url)), "utf8");
  assert.ok(bin.includes(`const RETIRED_FILE = "${RETIRED_FILE}";`));
  assert.equal(EXIT_RETIRED, 76);
  const unit = readFileSync(fileURLToPath(new URL("../../../../scripts/service/bantou-server.service.in", import.meta.url)), "utf8");
  assert.match(unit, /^RestartPreventExitStatus=75 76$/m);
  const plist = readFileSync(fileURLToPath(new URL("../../../../scripts/service/com.unagents.bantou.plist.in", import.meta.url)), "utf8");
  assert.ok(plist.includes(`<key>@HOME@/${RETIRED_FILE}</key><false/>`));
  assert.ok(plist.includes("<key>PathState</key>"));
  assert.ok(!plist.includes("<key>KeepAlive</key><true/>"));
  await stat(fileURLToPath(new URL("../../../../scripts/install-service.sh", import.meta.url)));
});
