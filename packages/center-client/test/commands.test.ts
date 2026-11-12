// Command arg builders: inputs and expectations copied from the Rust tests of the desktop (design 5.6 #5).
// S = packages/desktop/src-tauri/src/session.rs (tests at the end of the file).

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CommandError,
  SESSION_INSTRUCTIONS_MAX,
  createArgs,
  normalizeSettings,
  renameArgs,
  settingsOf,
  updateArgs,
  workspaceOf,
} from "../src/index.ts";

test("S: update body carries only what is given and move only with path", () => {
  assert.deepEqual(renameArgs("a", undefined, undefined, true), { name: "a" });
  assert.deepEqual(renameArgs("a", " b ", " ", undefined), { name: "a", newName: "b" });
  assert.deepEqual(renameArgs("a", undefined, " /x/y ", false), { name: "a", path: "/x/y", move: false });
  assert.deepEqual(renameArgs("a", undefined, "/x", undefined), { name: "a", path: "/x" });
});

test("S: settings are checked and blank instructions become null", () => {
  assert.deepEqual(normalizeSettings({ instructions: "  \n\t" }), { instructions: null });
  assert.deepEqual(normalizeSettings({ instructions: "a\n  b " }), { instructions: "a\n  b " });
  assert.deepEqual(normalizeSettings({ instructions: null }), { instructions: null });
  assert.deepEqual(normalizeSettings({}), {});
  // an item this client does not know passes through
  assert.deepEqual(normalizeSettings({ outputStyle: "x" }), { outputStyle: "x" });
  assert.doesNotThrow(() => normalizeSettings({ instructions: "あ".repeat(SESSION_INSTRUCTIONS_MAX) }));
  assert.throws(() => normalizeSettings({ instructions: "あ".repeat(SESSION_INSTRUCTIONS_MAX + 1) }), CommandError);
  assert.throws(() => normalizeSettings({ instructions: 1 }), CommandError);
  assert.throws(() => normalizeSettings("x"), CommandError);
  assert.throws(() => normalizeSettings([]), CommandError);
});

test("S: create body has path only when not blank and settings only with a non-null item", () => {
  assert.deepEqual(createArgs("a", undefined, undefined), { name: "a" });
  assert.deepEqual(createArgs("a", "  ", {}), { name: "a" });
  assert.deepEqual(createArgs("a", " /x ", { instructions: null }), { name: "a", path: "/x" });
  assert.deepEqual(createArgs("a", undefined, { instructions: "i", other: null }), { name: "a", settings: { instructions: "i" } });
});

test("S: update_args, settings_of, workspace_of", () => {
  assert.deepEqual(updateArgs("a", { instructions: null }), { name: "a", settings: { instructions: null } });
  assert.deepEqual(settingsOf({ name: "a", settings: { instructions: "x" } }), { instructions: "x" });
  assert.deepEqual(settingsOf({ name: "a" }), {});
  assert.deepEqual(settingsOf("x"), {});
  assert.equal(workspaceOf({ workspace: " /w " }), "/w");
  assert.equal(workspaceOf({ workspace: "  " }), null);
  assert.equal(workspaceOf({ workspace: null }), null);
  assert.equal(workspaceOf(null), null);
});
