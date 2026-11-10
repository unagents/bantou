import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { OUTPUT_STYLE_NAME, outputStyleContent, outputStyleFile, syncOutputStyleSync } from "../src/output-style.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "center-os-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

test("outputStyleContent: name は bantou に差し替え、他の frontmatter の key は残す。frontmatter が無ければ name と description を付ける。末尾は改行 1 つ", () => {
  assert.equal(outputStyleContent("Be brief."), `---\nname: ${OUTPUT_STYLE_NAME}\ndescription: bantou の設定（outputStyle）で指定した出力スタイル\n---\nBe brief.\n`);
  assert.equal(outputStyleContent("Be brief.\n"), outputStyleContent("Be brief."));
  // 貼った frontmatter: name だけ変え、description と keep-coding-instructions はそのまま
  const pasted = "---\nname: Concise Plus\ndescription: x\nkeep-coding-instructions: true\n---\n\nYou are terse.\n";
  assert.equal(outputStyleContent(pasted), `---\nname: ${OUTPUT_STYLE_NAME}\ndescription: x\nkeep-coding-instructions: true\n---\nYou are terse.\n`);
  // description が無い frontmatter には足す
  assert.equal(outputStyleContent("---\nname: a\nkeep-coding-instructions: true\n---\nbody"), `---\nname: ${OUTPUT_STYLE_NAME}\nkeep-coding-instructions: true\ndescription: bantou の設定（outputStyle）で指定した出力スタイル\n---\nbody\n`);
  assert.equal(outputStyleContent("---\r\nname: a\r\n---\r\nbody"), outputStyleContent("body"));
  // 区切りが閉じていない --- は本文として残す
  assert.ok(outputStyleContent("---\nnot frontmatter").endsWith("---\nnot frontmatter\n"));
});

test("syncOutputStyleSync: 本文があれば <path>/.claude/output-styles/bantou.md に書いて true。空なら消して false", async () => {
  const file = outputStyleFile(dir);
  assert.equal(file, join(dir, ".claude", "output-styles", "bantou.md"));
  assert.equal(syncOutputStyleSync(dir, "Be brief."), true);
  assert.equal(await readFile(file, "utf8"), outputStyleContent("Be brief."));
  assert.equal(syncOutputStyleSync(dir, "Changed."), true);
  assert.equal(await readFile(file, "utf8"), outputStyleContent("Changed."));
  assert.equal(syncOutputStyleSync(dir, ""), false);
  await assert.rejects(stat(file));
  assert.equal(syncOutputStyleSync(dir, ""), false); // 無い時も落ちない
});
