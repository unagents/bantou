import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { cloneGuardrailDraft, guardrailDraftError, guardrailDraftOf, guardrailUpdate, type GuardrailRow } from "../composables/guardrailSchemas";

const row = (name: string, text: string, saved = false): GuardrailRow => ({ name, text, saved });

describe("guardrailDraftOf", () => {
  test("rows by name, definition as pretty JSON text, saved", () => {
    const rows = guardrailDraftOf({ b: { x: 1 }, a: "text", c: null });
    assert.deepEqual(rows, [
      { name: "a", text: '"text"', saved: true },
      { name: "b", text: '{\n  "x": 1\n}', saved: true },
    ]);
  });
  test("nothing or a broken value is no rows", () => {
    for (const v of [undefined, null, [], "x", 1]) assert.deepEqual(guardrailDraftOf(v), []);
  });
});

describe("guardrailDraftError", () => {
  test("a valid draft has no problem; an empty draft too", () => {
    assert.equal(guardrailDraftError([row("spec-driven_1", '{"a":1}'), row("b", "[1]")]), null);
    assert.equal(guardrailDraftError([]), null);
  });
  test("a name outside letters, digits, _ - is refused (empty, slash, space, dot)", () => {
    for (const n of ["", "a/b", "a b", "a.b"]) assert.match(guardrailDraftError([row(n, "{}")]) ?? "", /英数字と _ - のみ/, n);
  });
  test("a duplicate name is refused", () => {
    assert.match(guardrailDraftError([row("a", "{}"), row("a", "[]")]) ?? "", /重なっている: a/);
  });
  test("text that is empty, not JSON, or null is refused with the name", () => {
    assert.match(guardrailDraftError([row("a", "  ")]) ?? "", /schema a: 中身が空/);
    assert.match(guardrailDraftError([row("a", "{oops")]) ?? "", /schema a: JSON として読めない/);
    assert.match(guardrailDraftError([row("a", "null")]) ?? "", /schema a: null は定義にできない/);
  });
  test("any other JSON value is a definition (string, number, false, 0)", () => {
    for (const t of ['"s"', "1", "false", "0", "[]", "{}"]) assert.equal(guardrailDraftError([row("a", t)]), null, t);
  });
});

describe("guardrailUpdate", () => {
  const a = row("a", '{"v":1}', true);
  const b = row("b", '{"v":2}', true);
  const base = [a, b];
  test("nothing changed → null (the item is left out)", () => {
    assert.equal(guardrailUpdate(cloneGuardrailDraft(base), base), null);
  });
  test("a new row sends its parsed value; unchanged rows are not sent", () => {
    assert.deepEqual(guardrailUpdate([...base, row("c", '{"v": 3}')], base), { c: { v: 3 } });
  });
  test("an edited row sends its new value", () => {
    assert.deepEqual(guardrailUpdate([row("a", '{"v":9}', true), b], base), { a: { v: 9 } });
  });
  test("a removed row sends null for its name", () => {
    assert.deepEqual(guardrailUpdate([a], base), { b: null });
  });
  test("remove and add together; a falsy value is sent as it is", () => {
    assert.deepEqual(guardrailUpdate([a, row("z", "false")], base), { b: null, z: false });
  });
  test("deleting everything sends a null per saved name (not the whole-item null)", () => {
    assert.deepEqual(guardrailUpdate([], base), { a: null, b: null });
  });
});
