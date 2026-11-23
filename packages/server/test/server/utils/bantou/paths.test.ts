import { test } from "node:test";
import assert from "node:assert/strict";
import { chmod, lstat, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureTmpDir, runLogDir, stateFile, workerDir } from "../../../../server/utils/bantou/paths";

test("paths: workerDir は workers/ の配下", () => {
  assert.equal(workerDir("/ws", "w_1"), "/ws/workers/w_1");
  assert.equal(stateFile("/ws/workers/w_1"), "/ws/workers/w_1/state.json");
  assert.equal(runLogDir("/ws/workers/w_1"), "/ws/workers/w_1/logs");
});

for (const id of ["../x", "a b", "", "a/b", ".."]) {
  test(`paths: 不正な id ${JSON.stringify(id)} は拒否`, () => {
    assert.throws(() => workerDir("/ws", id), /worker_id が不正/);
  });
}

test("ensureTmpDir: 無ければ mode 700 で作り、在れば mode を保つ。symlink / file は消して作り直す", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bantou-paths-test-"));
  try {
    const tmp = await ensureTmpDir(dir);
    assert.equal(tmp, join(dir, "tmp"));
    assert.equal((await lstat(tmp)).mode & 0o777, 0o700);
    await chmod(tmp, 0o750);
    await ensureTmpDir(dir);
    assert.equal((await lstat(tmp)).mode & 0o777, 0o750);

    await rm(tmp, { recursive: true });
    await symlink(tmpdir(), tmp);
    await ensureTmpDir(dir);
    assert.ok((await lstat(tmp)).isDirectory());

    await rm(tmp, { recursive: true });
    await writeFile(tmp, "x");
    await ensureTmpDir(dir);
    assert.ok((await lstat(tmp)).isDirectory());
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
