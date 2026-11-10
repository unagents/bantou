import assert from "node:assert/strict";
import { test } from "node:test";
import { createCore } from "../src/core.js";
import { createLoginFlow, LOGIN_CODE } from "../src/login.js";
import type { RcStatus, RemoteControlSupervisor } from "../src/remote-control.js";

const URL = "https://claude.com/cai/oauth/authorize?code=true&state=abc";

/** supervisor の偽物: status / resetLogin だけ。auth まわりはテストから直接書き換える。 */
function fakeSupervisor(names: string[]) {
  const map = new Map<string, RcStatus>();
  for (const n of names) {
    map.set(n, {
      project: n, path: "/p", state: "connected", pid: 1, sessionUrl: null, environmentUrl: null, restarts: 0, lastExit: null,
      startedAt: null, args: null, claude: { path: "claude", source: "PATH" }, auth: "login_required", loginUrl: null, loginError: null,
    });
  }
  const resets: string[] = [];
  const sup = {
    status: (n: string) => {
      const s = map.get(n);
      if (!s) throw new Error(`未定義の project: ${n}`);
      return { ...s };
    },
    resetLogin: (n: string) => {
      resets.push(n);
      const s = map.get(n)!;
      s.loginUrl = null;
      s.loginError = null;
    },
  } as unknown as RemoteControlSupervisor;
  return { sup, map, resets };
}

/** core に実行中の sink を繋ぎ、届いた入力を文字列で溜める。 */
function runningCore(name: string) {
  const core = createCore();
  const inputs: string[] = [];
  core.register(name);
  core.attach(name, { input: (d) => void inputs.push(d.toString()), resize: () => {} });
  return { core, inputs };
}

const timings = { escapeMs: 5, menuMs: 5, enterMs: 5, pollMs: 5, urlTimeoutMs: 500, codeTimeoutMs: 500 };

test("start: Esc → /login → Enter（方法 1）の順に打ち、URL が出たら返す。前の URL / 失敗理由は先に消す", async () => {
  const { sup, map, resets } = fakeSupervisor(["pm1"]);
  map.get("pm1")!.loginUrl = "https://old";
  map.get("pm1")!.loginError = "Invalid code";
  const { core, inputs } = runningCore("pm1");
  const flow = createLoginFlow({ supervisor: sup, core, log: () => {}, timings });
  const p = flow.start("pm1");
  // URL は入力が出揃ってから現れる
  await new Promise((r) => setTimeout(r, 40));
  assert.deepEqual(inputs, ["\u001b", "/login\r", "\r"]);
  map.get("pm1")!.loginUrl = URL;
  assert.deepEqual(await p, { name: "pm1", loginUrl: URL });
  assert.deepEqual(resets, ["pm1"]);
});

test("start: 実行中でない session・未定義の session・URL が出ない時は投げる", async () => {
  const { sup } = fakeSupervisor(["pm1"]);
  const idle = createCore();
  idle.register("pm1");
  const flow = createLoginFlow({ supervisor: sup, core: idle, log: () => {}, timings });
  await assert.rejects(flow.start("pm1"), /実行中でない/);
  await assert.rejects(flow.start("nope"), /未定義/);
  const { core } = runningCore("pm1");
  const slow = createLoginFlow({ supervisor: sup, core, log: () => {}, timings: { ...timings, urlTimeoutMs: 30 } });
  await assert.rejects(slow.start("pm1"), /認証 URL が出ない/);
});

test("code: コードと Enter を別々に打ち、成功（auth ok）で ok: true", async () => {
  const { sup, map } = fakeSupervisor(["pm1"]);
  map.get("pm1")!.loginUrl = URL;
  const { core, inputs } = runningCore("pm1");
  const flow = createLoginFlow({ supervisor: sup, core, log: () => {}, timings });
  const p = flow.code("pm1", "AbC_-123#state");
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(inputs, ["AbC_-123#state", "\r"]);
  // 成功: supervisor が ok にし URL を消す
  Object.assign(map.get("pm1")!, { auth: "ok", loginUrl: null, loginError: null });
  assert.deepEqual(await p, { name: "pm1", ok: true, auth: "ok", error: null });
});

test("code: Invalid code / keychain ロックは ok: false と理由。形式違いのコードと時間切れは投げる", async () => {
  const { sup, map } = fakeSupervisor(["pm1"]);
  const { core } = runningCore("pm1");
  const flow = createLoginFlow({ supervisor: sup, core, log: () => {}, timings });

  const bad = flow.code("pm1", "wrong#s");
  await new Promise((r) => setTimeout(r, 20));
  map.get("pm1")!.loginError = "Invalid code";
  assert.deepEqual(await bad, { name: "pm1", ok: false, auth: "login_required", error: "Invalid code" });

  const locked = flow.code("pm1", "right#s");
  await new Promise((r) => setTimeout(r, 20));
  Object.assign(map.get("pm1")!, { auth: "keychain_locked", loginError: "Couldn't save your login" });
  assert.deepEqual(await locked, { name: "pm1", ok: false, auth: "keychain_locked", error: "Couldn't save your login" });

  await assert.rejects(flow.code("pm1", "a b"), /code は/);
  await assert.rejects(flow.code("pm1", ""), /code は/);
  const slow = createLoginFlow({ supervisor: sup, core, log: () => {}, timings: { ...timings, codeTimeoutMs: 30 } });
  map.get("pm1")!.loginError = null;
  await assert.rejects(slow.code("pm1", "x#y"), /結果が出ない/);
});

test("LOGIN_CODE: claude の表示形式 <code>#<state> を通し、空白・改行・制御文字は弾く", () => {
  assert.ok(LOGIN_CODE.test("GeMgGyG13uhJ3IOUwmUsu9AnrSijIU8bNKSQrV46RSYdATxU#e62kJfVlI11dSfkwBwbnSOCrymD9OoiBr_FYy2NODus"));
  assert.ok(!LOGIN_CODE.test("abc def"));
  assert.ok(!LOGIN_CODE.test("abc\n"));
  assert.ok(!LOGIN_CODE.test("abc\u001b"));
  assert.ok(!LOGIN_CODE.test("a".repeat(513)));
});
