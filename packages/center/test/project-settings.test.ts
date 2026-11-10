import assert from "node:assert/strict";
import { test } from "node:test";
import { composeAddDirs, composeInstructions, composeOutputStyle, mergeSettings, projectSettingsPatchSchema, readSettings } from "../src/project-settings.js";

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

test("outputStyle: schema は 32000 文字以内の string か null。merge は空文字・null で削除。read は壊れた値を落とす。compose は session 優先で連結しない", () => {
  assert.equal(projectSettingsPatchSchema.safeParse({ outputStyle: "# style" }).success, true);
  assert.equal(projectSettingsPatchSchema.safeParse({ outputStyle: null }).success, true);
  assert.equal(projectSettingsPatchSchema.safeParse({ outputStyle: "a".repeat(32_001) }).success, false);
  assert.equal(projectSettingsPatchSchema.safeParse({ outputStyle: 1 }).success, false);
  assert.deepEqual(mergeSettings({ instructions: "i" }, { outputStyle: "s" }), { instructions: "i", outputStyle: "s" });
  assert.deepEqual(mergeSettings({ outputStyle: "s" }, { outputStyle: "" }), {});
  assert.deepEqual(mergeSettings({ outputStyle: "s" }, { outputStyle: null }), {});
  assert.deepEqual(readSettings({ outputStyle: "", a: 1 }), { a: 1 });
  assert.deepEqual(readSettings({ outputStyle: 3 }), {});
  assert.deepEqual(readSettings({ outputStyle: "s" }), { outputStyle: "s" });
  assert.equal(composeOutputStyle({ outputStyle: "共通" }, { outputStyle: "個別" }), "個別");
  assert.equal(composeOutputStyle({ outputStyle: "共通" }, {}), "共通");
  assert.equal(composeOutputStyle(undefined, { outputStyle: "個別" }), "個別");
  assert.equal(composeOutputStyle({ outputStyle: "共通" }, { outputStyle: "" }), "共通");
  assert.equal(composeOutputStyle(undefined, undefined), "");
});

test("servers: schema は host 名か server_id の配列（50 個以内）か null。形式が違うもの・多すぎるものは不正。merge は重複を除き、空配列は保存（= 使わない）、null で削除。read は壊れた値を未設定にする", async () => {
  const { composeServers, serverAllowed, SERVERS_MAX } = await import("../src/project-settings.js");
  assert.equal(projectSettingsPatchSchema.safeParse({ servers: ["lenovo", "mac-200.local", "srv-aaaaaaaaaa"] }).success, true);
  assert.equal(projectSettingsPatchSchema.safeParse({ servers: null }).success, true);
  assert.equal(projectSettingsPatchSchema.safeParse({ servers: [] }).success, true);
  for (const bad of [[""], ["a b"], [".x"], ["host/x"], [1], "lenovo", Array.from({ length: SERVERS_MAX + 1 }, (_, i) => `h${i}`)]) {
    assert.equal(projectSettingsPatchSchema.safeParse({ servers: bad }).success, false, JSON.stringify(bad).slice(0, 30));
  }
  assert.deepEqual(mergeSettings({ instructions: "i" }, { servers: ["a", "b", "a"] }), { instructions: "i", servers: ["a", "b"] });
  assert.deepEqual(mergeSettings({ servers: ["a"] }, { servers: [] }), { servers: [] }, "空配列は保存する（未設定と区別）");
  assert.deepEqual(mergeSettings({ servers: ["a"] }, { servers: null }), {});
  assert.deepEqual(mergeSettings({ servers: ["a"] }, { instructions: "x" }), { servers: ["a"], instructions: "x" });
  assert.deepEqual(readSettings({ servers: ["a", "", "a", 3] }), { servers: ["a"] });
  assert.deepEqual(readSettings({ servers: [] }), { servers: [] });
  assert.deepEqual(readSettings({ servers: "lenovo" }), {}, "壊れた値は未設定（全 server を止めない）");
  // composeServers は session の値だけを見る（共通は引数にも無い）
  assert.equal(composeServers(undefined), undefined);
  assert.equal(composeServers({}), undefined);
  assert.deepEqual(composeServers({ servers: ["s"] }), ["s"]);
  assert.deepEqual(composeServers({ servers: [] }), []);
  // 共通設定: schema に servers は無い。保存済みに残っていても読み捨てる
  const { centerSettingsPatchSchema, readCenterSettings } = await import("../src/project-settings.js");
  assert.equal("servers" in centerSettingsPatchSchema.shape, false);
  assert.deepEqual(readCenterSettings({ instructions: "i", servers: ["a"] }), { instructions: "i" });
  // 範囲の判定: server_id は完全一致、host 名は大文字小文字を区別しない。undefined は全部
  assert.equal(serverAllowed(undefined, {}), true);
  assert.equal(serverAllowed([], { server_id: "x", host: "h" }), false);
  assert.equal(serverAllowed(["LENOVO"], { host: "lenovo", server_id: "srv-a" }), true);
  assert.equal(serverAllowed(["srv-a"], { host: "lenovo", server_id: "srv-a" }), true);
  assert.equal(serverAllowed(["srv-a"], { host: "lenovo", server_id: "srv-b" }), false);
  assert.equal(serverAllowed(["lenovo"], { server_id: "srv-b" }), false, "host が分からない server は host 指定では通らない");
});
