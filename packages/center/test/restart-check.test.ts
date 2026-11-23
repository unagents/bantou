/** app 再起動後の状況確認（docs/design/app-restart-check.md の T1・T3〜T6・T11・T13・T14）。 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createRestartChecker, RESTART_CHECK_TEXT } from "../src/restart-check.js";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const PASTE = `\u001b[200~${RESTART_CHECK_TEXT}\u001b[201~`;

function setup(opts: { inputOk?: boolean; resessionPending?: boolean } = {}) {
  const inputs: string[] = [];
  const logs: string[] = [];
  const state = { inputOk: opts.inputOk ?? true, resessionPending: opts.resessionPending ?? false };
  const make = () =>
    createRestartChecker({
      core: {
        input: (_n, d) => {
          if (!state.inputOk) return false;
          inputs.push(d.toString());
          return true;
        },
      },
      resessionPending: () => state.resessionPending,
      log: (m) => void logs.push(m),
      submitDelayMs: 5,
    });
  return { make, inputs, logs, state };
}
const start = (source: string) => ({ hook_event_name: "SessionStart", source });

test("T1: arm した session は SessionStart(startup) の後に paste → Enter の順で 1 回受ける", async () => {
  const { make, inputs } = setup();
  const c = make();
  c.arm("s1");
  assert.equal(c.pending("s1"), true);
  c.onHook("s1", start("startup"));
  await sleep(40);
  assert.deepEqual(inputs, [PASTE, "\r"]);
  assert.equal(c.pending("s1"), false);
});

test("T1: arm していない session には送らない", async () => {
  const { make, inputs } = setup();
  const c = make();
  c.onHook("s1", start("startup"));
  await sleep(30);
  assert.deepEqual(inputs, []);
});

test("T3: 同じ session の 2 回目の SessionStart では送らない", async () => {
  const { make, inputs } = setup();
  const c = make();
  c.arm("s1");
  c.onHook("s1", start("startup"));
  c.onHook("s1", start("startup")); // 送信の途中（Enter 待ち）に来ても割り込まない
  await sleep(40);
  c.onHook("s1", start("compact"));
  c.onHook("s1", start("resume"));
  await sleep(40);
  assert.deepEqual(inputs, [PASTE, "\r"]);
});

test("T4: compact・clear は無視して印を残し、その後の startup で 1 回送る", async () => {
  const { make, inputs } = setup();
  const c = make();
  c.arm("s1");
  c.onHook("s1", start("compact"));
  c.onHook("s1", start("clear"));
  c.onHook("s1", { hook_event_name: "SessionStart" });
  c.onHook("s1", { hook_event_name: "Stop", source: "startup" });
  await sleep(30);
  assert.deepEqual(inputs, []);
  assert.equal(c.pending("s1"), true);
  c.onHook("s1", start("startup"));
  await sleep(40);
  assert.deepEqual(inputs, [PASTE, "\r"]);
});

test("T5: source=resume でも 1 回送る", async () => {
  const { make, inputs } = setup();
  const c = make();
  c.arm("s1");
  c.onHook("s1", start("resume"));
  await sleep(40);
  assert.deepEqual(inputs, [PASTE, "\r"]);
});

test("T6: resession.pending が true なら送らず、印は消える", async () => {
  const { make, inputs, state } = setup({ resessionPending: true });
  const c = make();
  c.arm("s1");
  c.onHook("s1", start("startup"));
  await sleep(30);
  assert.deepEqual(inputs, []);
  assert.equal(c.pending("s1"), false);
  state.resessionPending = false;
  c.onHook("s1", start("startup"));
  await sleep(30);
  assert.deepEqual(inputs, []);
});

test("cancel で印が外れ、後の startup で送らない", async () => {
  const { make, inputs } = setup();
  const c = make();
  c.arm("s1");
  c.cancel("s1");
  c.cancel("none");
  c.onHook("s1", start("startup"));
  await sleep(30);
  assert.deepEqual(inputs, []);
});

test("T11: core.input が false でも投げず、印は消え、再送しない", async () => {
  const { make, inputs, logs, state } = setup({ inputOk: false });
  const c = make();
  c.arm("s1");
  assert.doesNotThrow(() => c.onHook("s1", start("startup")));
  await sleep(30);
  assert.equal(c.pending("s1"), false);
  assert.ok(logs.some((l) => l.includes("送れない")));
  state.inputOk = true;
  c.onHook("s1", start("startup"));
  await sleep(30);
  assert.deepEqual(inputs, []);
});

test("T13: 新しい checker（center の再起動）で arm し直すとまた 1 回送る。別 checker の印は共有しない", async () => {
  const { make, inputs } = setup();
  const a = make();
  a.arm("s1");
  a.onHook("s1", start("startup"));
  await sleep(40);
  assert.equal(inputs.length, 2);
  const b = make();
  b.onHook("s1", start("startup")); // 印が無い
  await sleep(30);
  assert.equal(inputs.length, 2);
  b.arm("s1");
  b.onHook("s1", start("startup"));
  await sleep(40);
  assert.deepEqual(inputs, [PASTE, "\r", PASTE, "\r"]);
  // 別の checker の印は見えない（印は checker ごと。process 全体の static にしない）
  const c = make();
  const d = make();
  c.arm("s2");
  assert.equal(d.pending("s2"), false);
  d.onHook("s2", start("startup"));
  await sleep(30);
  assert.equal(inputs.length, 4);
});

test("T14: 文面に要点を含み、改行を含まない", () => {
  for (const w of ["app が再起動した", "[始める時]", "remote_list", "task_status", "未読の知らせ"]) {
    assert.ok(RESTART_CHECK_TEXT.includes(w), w);
  }
  assert.ok(!/[\r\n]/.test(RESTART_CHECK_TEXT));
});

test("不正な payload は無視する（投げない）", () => {
  const { make } = setup();
  const c = make();
  c.arm("s1");
  for (const p of [null, undefined, "x", 3, [], {}]) assert.doesNotThrow(() => c.onHook("s1", p));
  assert.equal(c.pending("s1"), true);
});
