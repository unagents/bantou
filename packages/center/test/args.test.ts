import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_BIND, DEFAULT_PORT, parseArgs } from "../src/args.js";

test("既定は stdio / 7910 / 127.0.0.1", () => {
  const a = parseArgs([]);
  assert.equal(a.transport, "stdio");
  assert.equal(a.port, DEFAULT_PORT);
  assert.equal(a.bind, DEFAULT_BIND);
});

test("http と port / bind / config を解釈する", () => {
  const a = parseArgs(["--transport", "http", "--port", "0", "--bind", "0.0.0.0", "--config", "/x.json"]);
  assert.deepEqual(a, { config: "/x.json", transport: "http", port: 0, bind: "0.0.0.0" });
});

test("不正な値・引数は Error", () => {
  assert.throws(() => parseArgs(["--transport", "ws"]), /--transport/);
  assert.throws(() => parseArgs(["--port", "abc"]), /--port/);
  assert.throws(() => parseArgs(["--port", "70000"]), /--port/);
  assert.throws(() => parseArgs(["--port", "-1"]), /--port/);
  assert.throws(() => parseArgs(["--bind", ""]), /--bind/);
  assert.throws(() => parseArgs(["--config"]), /値が無い/);
  assert.throws(() => parseArgs(["--nope"]), /不明な引数/);
  assert.throws(() => parseArgs(["extra"]), /不明な引数/);
});
