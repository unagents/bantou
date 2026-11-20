import assert from "node:assert/strict";
import { test } from "node:test";
import { AGENT_ID_PATTERN, MODEL_PATTERN } from "@agent-hand/bantou-protocol";
import { AGENT_ID_SCHEMA_PATTERN, MODEL_SCHEMA_PATTERN } from "../src/schema-patterns.js";

/** ASCII の全文字と、範囲外の文字を少し。 */
const CHARS = [...Array.from({ length: 128 }, (_, i) => String.fromCharCode(i)), "é", "あ", "\u{1F600}"];

/** 長さ 0〜2 の全ての組み合わせと、実際に使う形の文字列。 */
function samples(): string[] {
  const out = ["", "sonnet", "opus[1m]", "claude-fable-5-2", "a.b_c-d", "-x", "x-", "[", "]", "a b", "pm1", "c-1a2b3c-pm1"];
  for (const a of CHARS) {
    out.push(a);
    for (const b of CHARS) out.push(a + b);
  }
  return out;
}

test("schema 用の pattern は protocol の pattern と同じ文字列を受け付ける", () => {
  for (const [name, schema, proto] of [
    ["AGENT_ID", AGENT_ID_SCHEMA_PATTERN, AGENT_ID_PATTERN],
    ["MODEL", MODEL_SCHEMA_PATTERN, MODEL_PATTERN],
  ] as const) {
    for (const s of samples()) assert.equal(schema.test(s), proto.test(s), `${name}: ${JSON.stringify(s)}`);
  }
});

test("schema 用の pattern は RegExp の v / u の両方で compile できる", () => {
  for (const p of [AGENT_ID_SCHEMA_PATTERN, MODEL_SCHEMA_PATTERN]) {
    for (const flag of ["v", "u"]) assert.doesNotThrow(() => new RegExp(p.source, flag), `${p.source} /${flag}`);
  }
});
