import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { MESSENGER_PROTOCOL } from "@agent-hand/bantou-protocol";
import { resolvePair } from "../src/pair.js";

test("pair: env の版が最優先。protocol はこのバイナリの MESSENGER_PROTOCOL", () => {
  const p = resolvePair({ envValue: "0.4.0", readPackage: () => "9.9.9" });
  assert.deepEqual(p, { server: "0.4.0", protocol: MESSENGER_PROTOCOL.version });
});

test("pair: env が無い・空なら package.json の版", () => {
  assert.equal(resolvePair({ envValue: undefined, readPackage: () => "0.2.3" }).server, "0.2.3");
  assert.equal(resolvePair({ envValue: "", readPackage: () => "0.2.3" }).server, "0.2.3");
});

test("pair: env が不正なら警告して package.json にフォールバック", () => {
  const warns: string[] = [];
  const p = resolvePair({ envValue: "latest", readPackage: () => "0.2.3", warn: (m) => warns.push(m) });
  assert.equal(p.server, "0.2.3");
  assert.equal(warns.length, 1);
});

test("pair: どちらも無い・不正なら server は undefined（版合わせは無効）", () => {
  assert.equal(resolvePair({ envValue: undefined, readPackage: () => undefined }).server, undefined);
  assert.equal(resolvePair({ envValue: undefined, readPackage: () => "x" }).server, undefined);
});

test("pair: 既定は作業ツリーの server/package.json の版（src から ../../../server/package.json）", () => {
  const want = (JSON.parse(readFileSync(new URL("../../../server/package.json", import.meta.url), "utf8")) as { version: string }).version;
  assert.equal(resolvePair({ envValue: undefined }).server, want);
});
