import assert from "node:assert/strict";
import { test } from "node:test";
import { createCore, type CoreEvent } from "../src/core.js";
import { createSessionTokens } from "../src/session-auth.js";

const buf = (s: string): Buffer => Buffer.from(s);
const collect = (core: ReturnType<typeof createCore>, name: string, after?: number) => {
  const evs: CoreEvent[] = [];
  const unsub = core.subscribe(name, after, (e) => evs.push(e));
  return { evs, unsub };
};
const summary = (evs: CoreEvent[]): string[] =>
  evs.map((e) => (e.type === "chunk" ? `${e.id}:${e.data.toString()}` : e.type));

test("push: チャンク ID は 1 から連番。未登録への push は投げる", () => {
  const core = createCore();
  assert.throws(() => core.push("x", buf("a")), /未登録/);
  core.register("s");
  core.register("s"); // 冪等
  assert.equal(core.push("s", buf("a")), 1);
  assert.equal(core.push("s", buf("b")), 2);
});

test("subscribe: after 無しは reset + 全部、live も届く。未登録は null", () => {
  const core = createCore();
  assert.equal(core.subscribe("nope", undefined, () => {}), null);
  core.register("s");
  core.push("s", buf("a"));
  core.push("s", buf("b"));
  const { evs, unsub } = collect(core, "s");
  assert.deepEqual(summary(evs), ["reset", "1:a", "2:b"]);
  core.push("s", buf("c"));
  assert.deepEqual(summary(evs), ["reset", "1:a", "2:b", "3:c"]);
  unsub!();
  core.push("s", buf("d"));
  assert.equal(evs.length, 4); // 解除後は届かない
});

test("subscribe: after が続きとして使える時は reset 無しで after より後だけ", () => {
  const core = createCore();
  core.register("s");
  for (const w of ["a", "b", "c"]) core.push("s", buf(w));
  assert.deepEqual(summary(collect(core, "s", 1).evs), ["2:b", "3:c"]);
  assert.deepEqual(summary(collect(core, "s", 3).evs), []);
  assert.deepEqual(summary(collect(core, "s", 0).evs), ["1:a", "2:b", "3:c"]); // 先頭から全部残っている
});

test("subscribe: 空のキューでも after = 最新なら reset しない。最新より先の after（古い center の ID）は reset", () => {
  const core = createCore();
  core.register("s");
  assert.deepEqual(summary(collect(core, "s", 0).evs), []);
  assert.deepEqual(summary(collect(core, "s").evs), ["reset"]);
  core.push("s", buf("a"));
  assert.deepEqual(summary(collect(core, "s", 99).evs), ["reset", "1:a"]);
});

test("上限を超えたら古いチャンクから落とす。落ちた分より前の after は reset + 残り（ID は再利用しない）", () => {
  const core = createCore({ maxBytes: 10 });
  core.register("s");
  core.push("s", buf("aaaa")); // 1
  core.push("s", buf("bbbb")); // 2 (計 8)
  core.push("s", buf("cccc")); // 3 -> 1 が落ちる (計 8)
  core.push("s", buf("dddd")); // 4 -> 2 が落ちる
  assert.deepEqual(summary(collect(core, "s").evs), ["reset", "3:cccc", "4:dddd"]);
  assert.deepEqual(summary(collect(core, "s", 1).evs), ["reset", "3:cccc", "4:dddd"]); // 欠けた
  assert.deepEqual(summary(collect(core, "s", 2).evs), ["3:cccc", "4:dddd"]); // 2 までは受け取り済み、3 から連続
  assert.equal(core.push("s", buf("e")), 5);
});

test("既定の上限は 8 MiB（デコード後バイト数の合計）", () => {
  const core = createCore();
  core.register("s");
  const mib = Buffer.alloc(1024 * 1024);
  for (let i = 0; i < 9; i++) core.push("s", mib);
  const { evs } = collect(core, "s");
  assert.equal(evs.filter((e) => e.type === "chunk").length, 8);
  assert.equal(summary(evs)[1].startsWith("2:"), true);
});

test("wrapper の入れ替えでキューと ID は続く。attach 前後で input / resize の可否が変わる。サイズは覚える", () => {
  const core = createCore();
  core.register("s");
  core.push("s", buf("a"));
  assert.equal(core.input("s", buf("x")), false);
  assert.equal(core.resize("s", 80, 24), false);
  assert.equal(core.size("s"), null);
  const got: string[] = [];
  core.attach("s", { input: (d) => got.push(d.toString()), resize: (c, r) => got.push(`${c}x${r}`) });
  assert.equal(core.running("s"), true);
  assert.equal(core.input("s", buf("x")), true);
  assert.equal(core.resize("s", 100, 30), true);
  assert.deepEqual(got, ["x", "100x30"]);
  core.detach("s");
  assert.equal(core.running("s"), false);
  assert.deepEqual(core.size("s"), { cols: 100, rows: 30 }); // 再起動後の初期値に使える
  assert.equal(core.push("s", buf("b")), 2);
});

test("remove: 購読者に end を送り、キューごと消える", () => {
  const core = createCore();
  core.register("s");
  const { evs } = collect(core, "s");
  core.remove("s");
  assert.deepEqual(summary(evs), ["reset", "end"]);
  assert.equal(core.has("s"), false);
  core.remove("s"); // 冪等
});

test("session token: session 名に束縛、発行し直すと前のは無効、revoke で無効", () => {
  const t = createSessionTokens();
  const a = t.issue("a");
  const b = t.issue("b");
  assert.ok(a.length >= 12 && a !== b);
  assert.equal(t.verify("a", a), true);
  assert.equal(t.verify("b", a), false);
  assert.equal(t.verify("a", "x"), false);
  assert.equal(t.verify("c", a), false);
  const a2 = t.issue("a");
  assert.equal(t.verify("a", a), false);
  assert.equal(t.verify("a", a2), true);
  t.revoke("a");
  assert.equal(t.verify("a", a2), false);
});
