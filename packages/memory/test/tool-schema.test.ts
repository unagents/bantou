import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z, type ZodRawShape } from "zod";
import { eventShape } from "../server/utils/events.ts";
import { contextShape, explainShape, recallShape } from "../server/utils/recall.ts";

const TOOLS_DIR = fileURLToPath(new URL("../server/mcp/tools/", import.meta.url));

/** tool の定義 file（toolkit が file 名を tool 名にして登録する）と、その inputSchema。定義 file は nitro の runtime を読み込むので test では import しない。 */
const SHAPES: Record<string, [string, ZodRawShape]> = {
  "context.ts": ["contextShape", contextShape],
  "event.ts": ["eventShape", eventShape],
  "explain.ts": ["explainShape", explainShape],
  "recall.ts": ["recallShape", recallShape],
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

test("全 tool の inputSchema の pattern は RegExp の v / u の両方で compile できる（Claude の API に schema を弾かれない形）", async () => {
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
  const found: { path: string; pattern: string }[] = [];
  for (const t of tools) collectPatterns(t.inputSchema, t.name, found);
  // explain の id（uuid）は pattern として出る。辿り漏れの検出
  assert.ok(found.some((f) => f.path === "explain.properties.id"), "explain.id");
  if (process.env.PATTERN_DUMP) console.log("PATTERN_DUMP " + JSON.stringify(found));
  const bad: string[] = [];
  for (const f of found) {
    for (const flag of ["v", "u"]) {
      try {
        new RegExp(f.pattern, flag);
      } catch (e) {
        bad.push(`${f.path} /${f.pattern}/${flag}: ${(e as Error).message}`);
      }
    }
  }
  assert.deepEqual(bad, []);
});
