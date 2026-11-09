import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveDefaultConfig } from "../../../../bin/default-config.mjs";

const home = "/h/user";
const legacy = "/h/user/.config/bantou/config.json";
const has = (...paths: string[]) => (p: string) => paths.includes(p);

test("resolveDefaultConfig: BANTOU_HOME を優先、無ければ HOME", () => {
  assert.equal(resolveDefaultConfig({ env: { BANTOU_HOME: "/srv/b" }, home, exists: has("/srv/b/config.json", legacy) }), "/srv/b/config.json");
  assert.equal(resolveDefaultConfig({ env: {}, home, exists: has("/h/user/config.json", legacy) }), "/h/user/config.json");
  assert.equal(resolveDefaultConfig({ env: { BANTOU_HOME: "" }, home, exists: has("/h/user/config.json") }), "/h/user/config.json");
});

test("resolveDefaultConfig: 新が無く旧があれば旧に fallback、どちらも無ければ新", () => {
  assert.equal(resolveDefaultConfig({ env: {}, home, exists: has(legacy) }), legacy);
  assert.equal(resolveDefaultConfig({ env: { BANTOU_HOME: "/srv/b" }, home, exists: has(legacy) }), legacy);
  assert.equal(resolveDefaultConfig({ env: { BANTOU_HOME: "/srv/b" }, home, exists: has() }), "/srv/b/config.json");
});
