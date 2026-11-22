import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z, type ZodRawShape } from "zod";
import { eventShape, handoffShape } from "../server/utils/events.ts";
import { contextShape, explainShape, recallShape } from "../server/utils/recall.ts";

const TOOLS_DIR = fileURLToPath(new URL("../server/mcp/tools/", import.meta.url));

/** 入力の無い tool。定義 file には `inputSchema: {},`（空の shape）と書く。入力を足す時は shape に名前を付けて export し、ここを差し替える。 */
const NO_INPUT: [string, ZodRawShape] = ["{}", {}];

/**
 * tool の定義 file（toolkit が file 名を tool 名にして登録する）と、その inputSchema（定義 file に書いてある式、その shape）。
 * 定義 file は nitro の runtime を読み込むので test では import しない。入力の無い tool も NO_INPUT として載せる（載せない tool を作らない）。
 */
const SHAPES: Record<string, [string, ZodRawShape]> = {
  "context.ts": ["contextShape", contextShape],
  "event.ts": ["eventShape", eventShape],
  "handoff.ts": ["handoffShape", handoffShape],
  "explain.ts": ["explainShape", explainShape],
  "recall.ts": ["recallShape", recallShape],
  "status.ts": NO_INPUT,
};

/** schema を再帰的に辿り、`pattern`（文字列）をすべて集める。 */
function collectPatterns(node: unknown, path: string, out: { path: string; pattern: string }[]): void {
  if (Array.isArray(node)) return node.forEach((v, i) => collectPatterns(v, `${path}[${i}]`, out));
  if (node === null || typeof node !== "object") return;
  for (const [k, v] of Object.entries(node)) {
    if (k === "pattern" && typeof v === "string") out.push({ path, pattern: v });
    else collectPatterns(v, `${path}.${k}`, out);
  }
}

/**
 * 文字 class の中にある escape の無い `[` の位置（無ければ -1）。`\[` は可。class の外の `[` は class の開始として扱う。
 * Claude の API が tool の schema を「JSON schema is invalid」で弾く形を捉えるための検査。
 * この基準は実測 2 例（`[A-Za-z0-9._[\]]` は弾かれ、`[A-Za-z0-9._\[\]]` は通った）から作った推測で、API の本当の基準ではない。
 * 本当に通るかは実際の API で確かめる（docs/history/20261120-fix-tool-schema-pattern/report.md）。
 */
function unescapedBracketInClass(p: string): number {
  let inClass = false;
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === "\\") i++;
    else if (!inClass) inClass = c === "[";
    else if (c === "]") inClass = false;
    else if (c === "[") return i;
  }
  return -1;
}

/** pattern のうち、`u` で compile できない物と、文字 class の中に escape の無い `[` を持つ物。 */
function badPatterns(found: { path: string; pattern: string }[]): string[] {
  const bad: string[] = [];
  for (const f of found) {
    try {
      new RegExp(f.pattern, "u");
    } catch (e) {
      bad.push(`${f.path} /${f.pattern}/u: ${(e as Error).message}`);
    }
    const at = unescapedBracketInClass(f.pattern);
    if (at >= 0) bad.push(`${f.path} /${f.pattern}/: 文字 class の中に escape の無い [（位置 ${at}）`);
  }
  return bad;
}

test("pattern の検査: 文字 class の中の escape の無い [ だけを不正とする", () => {
  const bad = (p: string) => badPatterns([{ path: "x", pattern: p }]).length > 0;
  assert.equal(bad("^[A-Za-z0-9._[\\]][A-Za-z0-9._[\\]-]*$"), true, "修正前の worker_start.model");
  assert.equal(bad("^[A-Za-z0-9._\\[\\]][A-Za-z0-9._\\[\\]-]*$"), false, "[ ] だけ escape した形");
  assert.equal(bad("^[A-Za-z0-9_-]+$"), false, "escape の無い - は可");
  assert.equal(bad("^[+-]\\d{2}$"), false);
  assert.equal(bad("^\\[[a-z]+\\]$"), false, "class の外の \\[");
  assert.equal(bad("^[a-z][0-9]$"), false, "class が 2 つ");
  assert.equal(bad("[a[b]"), true);
  assert.equal(bad("(a"), true, "compile できない");
});

test("全 tool の inputSchema の pattern は u で compile でき、文字 class の中に escape の無い [ を持たない（Claude の API に schema を弾かれない形）", async () => {
  // server/mcp/tools/ の全 tool の inputSchema を JSON Schema にする。
  // この package は MCP の SDK を直接の依存に持たないので、tools/list の代わりに SDK と同じ zod の変換（z.toJSONSchema）を使う
  const files = readdirSync(TOOLS_DIR).filter((f) => f.endsWith(".ts")).sort();
  assert.deepEqual(files, Object.keys(SHAPES).sort(), "tool が増減したら SHAPES を合わせる");
  const tools: { name: string; inputSchema: unknown }[] = [];
  for (const f of files) {
    const [shapeName, shape] = SHAPES[f]!;
    assert.ok(readFileSync(TOOLS_DIR + f, "utf8").includes(`inputSchema: ${shapeName},`), `${f} の inputSchema は ${shapeName}`);
    tools.push({ name: f.replace(/\.ts$/, ""), inputSchema: z.toJSONSchema(z.object(shape), { io: "input" }) });
  }
  assert.equal(tools.length, files.length);
  // 入力の無い tool（status）も schema を作って検査に通す。空の object になる
  const status = tools.find((t) => t.name === "status")?.inputSchema as { type?: unknown; properties?: unknown } | undefined;
  assert.equal(status?.type, "object", "status.type");
  assert.deepEqual(status?.properties, {}, "status は入力無し");
  const found: { path: string; pattern: string }[] = [];
  for (const t of tools) collectPatterns(t.inputSchema, t.name, found);
  // explain の id（uuid）は pattern として出る。辿り漏れの検出
  assert.ok(found.some((f) => f.path === "explain.properties.id"), "explain.id");
  if (process.env.PATTERN_DUMP) console.log("PATTERN_DUMP " + JSON.stringify(found));
  assert.deepEqual(badPatterns(found), []);
});
