import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { cloneGuardrailDraft, guardrailDraftError, guardrailDraftOf, guardrailUpdate, isTemplatePath, type GuardrailRow } from "../composables/guardrailSchemas";

const row = (name: string, schema: string, templates: Record<string, string> = {}, saved = false): GuardrailRow => ({
  name,
  schema,
  templates: Object.entries(templates).map(([path, body]) => ({ path, body })),
  saved,
});

describe("guardrailDraftOf", () => {
  test("rows by name, schema text as it is, templates by path, saved", () => {
    const rows = guardrailDraftOf({ b: { schema: "name: b\n", templates: { "z.md": "Z", "a/y.md": "Y" } }, a: { schema: "", templates: {} } });
    assert.deepEqual(rows, [
      { name: "a", schema: "", templates: [], saved: true },
      {
        name: "b",
        schema: "name: b\n",
        templates: [
          { path: "a/y.md", body: "Y" },
          { path: "z.md", body: "Z" },
        ],
        saved: true,
      },
    ]);
  });
  test("templates left out is no templates", () => {
    assert.deepEqual(guardrailDraftOf({ a: { schema: "s" } }), [{ name: "a", schema: "s", templates: [], saved: true }]);
  });
  test("nothing or a broken value is no rows (the old form is dropped)", () => {
    for (const v of [undefined, null, [], "x", 1]) assert.deepEqual(guardrailDraftOf(v), []);
    assert.deepEqual(guardrailDraftOf({ a: { name: "x" }, b: "text", c: null, d: [1], e: { schema: 1 }, f: { schema: "s", templates: { p: 1 } }, g: { schema: "s", templates: [] } }), []);
  });
});

describe("isTemplatePath", () => {
  test("a relative path of non-empty parts", () => {
    for (const p of ["a", "a.md", "a/b/c.md", ".hidden", "..a", "a..b", "a b"]) assert.equal(isTemplatePath(p), true, p);
  });
  test("empty, absolute, empty part, . or .. part, backslash, NUL are refused", () => {
    for (const p of ["", "/a", "a/", "a//b", ".", "..", "a/./b", "a/../b", "../a", "a\\b", "a\0b"]) assert.equal(isTemplatePath(p), false, JSON.stringify(p));
  });
});

describe("guardrailDraftError", () => {
  test("a valid draft has no problem; an empty draft and an empty schema too", () => {
    assert.equal(guardrailDraftError([row("spec-driven_1", "a: 1", { "x.md": "" }), row("B.2", "")]), null);
    assert.equal(guardrailDraftError([]), null);
  });
  test("a name outside the rule is refused (empty, slash, space, leading . _ -)", () => {
    for (const n of ["", "a/b", "a b", ".a", "_a", "-a"]) assert.match(guardrailDraftError([row(n, "")]) ?? "", /英数字で始まり/, n);
  });
  test("a name with . inside or case differences is fine", () => {
    assert.equal(guardrailDraftError([row("a.b", ""), row("A.b", "")]), null);
  });
  test("a duplicate name is refused", () => {
    assert.match(guardrailDraftError([row("a", ""), row("a", "x")]) ?? "", /重なっている: a/);
  });
  test("the schema text is not read (any text is fine, even broken YAML)", () => {
    for (const t of ["", "  ", "{oops", "\t: [", "null"]) assert.equal(guardrailDraftError([row("a", t)]), null, t);
  });
  test("a bad template path is refused with the name", () => {
    for (const p of ["", "/a", "a//b", "..", "a/../b", "a\\b", "a\0b"]) assert.match(guardrailDraftError([row("a", "", { [p]: "x" })]) ?? "", /schema a: template の path は/, JSON.stringify(p));
  });
  test("a duplicate template path in one schema is refused; the same path in two schemas is fine", () => {
    const dup: GuardrailRow = { name: "a", schema: "", saved: false, templates: [{ path: "x", body: "1" }, { path: "x", body: "2" }] };
    assert.match(guardrailDraftError([dup]) ?? "", /schema a: template の path が重なっている: x/);
    assert.equal(guardrailDraftError([row("a", "", { x: "1" }), row("b", "", { x: "1" })]), null);
  });
});

describe("guardrailUpdate", () => {
  const a = row("a", "v: 1", { "t.md": "T" }, true);
  const b = row("b", "v: 2", {}, true);
  const base = [a, b];
  test("nothing changed → null (the item is left out)", () => {
    assert.equal(guardrailUpdate(cloneGuardrailDraft(base), base), null);
  });
  test("a new row sends { schema, templates }; templates is {} when there is none; unchanged rows are not sent", () => {
    assert.deepEqual(guardrailUpdate([...base, row("c", "v: 3")], base), { c: { schema: "v: 3", templates: {} } });
    assert.deepEqual(guardrailUpdate([...base, row("d", "", { "x/y.md": "Y" })], base), { d: { schema: "", templates: { "x/y.md": "Y" } } });
  });
  test("an edited schema sends the whole definition (templates too)", () => {
    assert.deepEqual(guardrailUpdate([row("a", "v: 9", { "t.md": "T" }, true), b], base), { a: { schema: "v: 9", templates: { "t.md": "T" } } });
  });
  test("an edited, added or removed template sends the whole definition", () => {
    assert.deepEqual(guardrailUpdate([row("a", "v: 1", { "t.md": "T2" }, true), b], base), { a: { schema: "v: 1", templates: { "t.md": "T2" } } });
    assert.deepEqual(guardrailUpdate([row("a", "v: 1", { "t.md": "T", "u.md": "U" }, true), b], base), { a: { schema: "v: 1", templates: { "t.md": "T", "u.md": "U" } } });
    assert.deepEqual(guardrailUpdate([row("a", "v: 1", {}, true), b], base), { a: { schema: "v: 1", templates: {} } });
  });
  test("a renamed template path counts as a change", () => {
    assert.deepEqual(guardrailUpdate([row("a", "v: 1", { "n.md": "T" }, true), b], base), { a: { schema: "v: 1", templates: { "n.md": "T" } } });
  });
  test("a removed row sends null for its name", () => {
    assert.deepEqual(guardrailUpdate([a], base), { b: null });
  });
  test("remove and add together", () => {
    assert.deepEqual(guardrailUpdate([a, row("z", "")], base), { b: null, z: { schema: "", templates: {} } });
  });
  test("deleting everything sends a null per saved name (not the whole-item null)", () => {
    assert.deepEqual(guardrailUpdate([], base), { a: null, b: null });
  });
  test("a template path __proto__ stays an own key", () => {
    const u = guardrailUpdate([row("n", "", { ["__proto__"]: "x" })], [])!;
    assert.deepEqual(Object.keys(u.n!.templates), ["__proto__"]);
  });
});
