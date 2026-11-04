import assert from "node:assert/strict";
import { test } from "node:test";
import { composeAddDirs, composeInstructions, mergeSettings, projectSettingsPatchSchema, readSettings } from "../src/project-settings.js";

test("mergeSettings: 省略は変えない・値は上書き・null は削除・instructions の空文字は削除・未知項目は保持。元は変えない", () => {
  const cur = { instructions: "a", x: 1, y: { z: 2 } };
  assert.deepEqual(mergeSettings(cur, {}), cur);
  assert.deepEqual(mergeSettings(cur, { instructions: "b" }), { instructions: "b", x: 1, y: { z: 2 } });
  assert.deepEqual(mergeSettings(cur, { instructions: "" }), { x: 1, y: { z: 2 } });
  assert.deepEqual(mergeSettings(cur, { x: null, y: undefined }), { instructions: "a", y: { z: 2 } });
  assert.deepEqual(mergeSettings(undefined, { future: "v" }), { future: "v" });
  assert.deepEqual(mergeSettings(cur, { s: "" }), { ...cur, s: "" }); // 未知項目の空文字は値として保持
  assert.deepEqual(cur, { instructions: "a", x: 1, y: { z: 2 } });
});

test("projectSettingsPatchSchema: instructions は 16000 文字以内の string か null。未知項目は素通し。object 以外は不正", () => {
  assert.deepEqual(projectSettingsPatchSchema.parse({ instructions: "x", k: [1] }), { instructions: "x", k: [1] });
  assert.equal(projectSettingsPatchSchema.safeParse({ instructions: null }).success, true);
  assert.equal(projectSettingsPatchSchema.safeParse({ instructions: "a".repeat(16_001) }).success, false);
  assert.equal(projectSettingsPatchSchema.safeParse({ instructions: 1 }).success, false);
  assert.equal(projectSettingsPatchSchema.safeParse("x").success, false);
});

test("readSettings: 壊れた値は {}、空の instructions は落とす、未知項目は保持", () => {
  assert.deepEqual(readSettings(undefined), {});
  assert.deepEqual(readSettings([1]), {});
  assert.deepEqual(readSettings({ instructions: "", a: 1 }), { a: 1 });
  assert.deepEqual(readSettings({ instructions: 3, a: 1 }), { a: 1 });
  assert.deepEqual(readSettings({ instructions: "i", a: 1 }), { instructions: "i", a: 1 });
});

test("addDirs: schema は絶対パスの配列（20 個以内）か null。merge は空配列を削除・重複を除く。read は壊れた値を落とす", () => {
  assert.equal(projectSettingsPatchSchema.safeParse({ addDirs: ["/a", "/b/c"] }).success, true);
  assert.equal(projectSettingsPatchSchema.safeParse({ addDirs: null }).success, true);
  assert.equal(projectSettingsPatchSchema.safeParse({ addDirs: [] }).success, true);
  assert.equal(projectSettingsPatchSchema.safeParse({ addDirs: ["rel/x"] }).success, false);
  assert.equal(projectSettingsPatchSchema.safeParse({ addDirs: [""] }).success, false);
  assert.equal(projectSettingsPatchSchema.safeParse({ addDirs: "/a" }).success, false);
  assert.equal(projectSettingsPatchSchema.safeParse({ addDirs: Array.from({ length: 21 }, (_, i) => `/d${i}`) }).success, false);
  assert.deepEqual(mergeSettings({ instructions: "i" }, { addDirs: ["/a", "/b", "/a"] }), { instructions: "i", addDirs: ["/a", "/b"] });
  assert.deepEqual(mergeSettings({ addDirs: ["/a"] }, { addDirs: [] }), {});
  assert.deepEqual(mergeSettings({ addDirs: ["/a"] }, { addDirs: null }), {});
  assert.deepEqual(mergeSettings({ addDirs: ["/a"] }, { instructions: "x" }), { addDirs: ["/a"], instructions: "x" });
  assert.deepEqual(readSettings({ addDirs: ["/a", "", "/a", 3], k: 1 }), { addDirs: ["/a"], k: 1 });
  assert.deepEqual(readSettings({ addDirs: "/a" }), {});
  assert.deepEqual(readSettings({ addDirs: [] }), {});
});

test("composeInstructions / composeAddDirs: 共通が先。instructions は空行で結合、addDirs は重複を除く", () => {
  assert.equal(composeInstructions({ instructions: "共通" }, { instructions: "個別" }), "共通\n\n個別");
  assert.equal(composeInstructions({ instructions: "共通" }, {}), "共通");
  assert.equal(composeInstructions(undefined, { instructions: "個別" }), "個別");
  assert.equal(composeInstructions(undefined, undefined), "");
  assert.deepEqual(composeAddDirs({ addDirs: ["/c1", "/both"] }, { addDirs: ["/s1", "/both"] }), ["/c1", "/both", "/s1"]);
  assert.deepEqual(composeAddDirs(undefined, { addDirs: ["/s1"] }), ["/s1"]);
  assert.deepEqual(composeAddDirs({ addDirs: ["/c1"] }, undefined), ["/c1"]);
  assert.deepEqual(composeAddDirs({}, {}), []);
});
