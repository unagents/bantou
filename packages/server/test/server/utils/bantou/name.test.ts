import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { buildServerName, nameKey, readMachineId } from "../../../../server/utils/bantou/name";

const sha10 = (s: string): string => createHash("sha256").update(s).digest("hex").slice(0, 10);

test("nameKey: sha256('bantou-name/v1:' + 小文字・前後の空白を除いた ID) の hex の先頭 10 桁", () => {
  assert.equal(nameKey("abc123"), sha10("bantou-name/v1:abc123"));
  assert.equal(nameKey("  ABC123\n"), sha10("bantou-name/v1:abc123"));
  assert.equal(nameKey("ABC123").length, 10);
  assert.match(nameKey("x"), /^[0-9a-f]{10}$/);
  assert.notEqual(nameKey("a"), nameKey("b"));
});

test("nameKey: 空の ID は投げる", () => {
  assert.throws(() => nameKey(""), /空/);
  assert.throws(() => nameKey(" \n"), /空/);
});

test("buildServerName: [<prefix>-]bantou-server-<key>", () => {
  const key = nameKey("m1");
  assert.equal(buildServerName("m1"), `bantou-server-${key}`);
  assert.equal(buildServerName("m1", "prod"), `prod-bantou-server-${key}`);
  assert.equal(buildServerName("m1", "a1b2c3d4e5f6g7h8"), `a1b2c3d4e5f6g7h8-bantou-server-${key}`);
});

test("buildServerName: prefix は英小文字・数字 1〜16 文字", () => {
  for (const bad of ["", "Prod", "a-b", "a_b", "a b", "a".repeat(17)]) {
    assert.throws(() => buildServerName("m1", bad), /prefix/, JSON.stringify(bad));
  }
});

test("readMachineId: この host で読めるか、読めなければ投げる（darwin は ioreg が無ければ投げる）", () => {
  let id: string | undefined;
  try {
    id = readMachineId("linux");
  } catch (e) {
    assert.match((e as Error).message, /機械の ID を読めない/);
  }
  if (id !== undefined) assert.ok(id.trim().length > 0);
  if (process.platform !== "darwin") assert.throws(() => readMachineId("darwin"), /機械の ID を読めない/);
});
