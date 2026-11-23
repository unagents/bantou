import assert from "node:assert/strict";
import { test } from "node:test";
import { parse, validate } from "graphql";
import * as docs from "../../ui/api/graphql-docs.ts";
import { buildSchema } from "../src/graphql/schema.js";

// The documents the screens send (packages/ui/api/graphql-docs.ts) must be valid against this center's schema:
// a field renamed or dropped here would otherwise only show on a screen.
test("every GraphQL document of the screens is valid against the schema", () => {
  const schema = buildSchema();
  const all = Object.entries(docs).filter(([k, v]) => /^[QMS]_/.test(k) && typeof v === "string") as [string, string][];
  assert.ok(all.length >= 19, `documents found: ${all.length}`);
  for (const [name, source] of all) {
    const errors = validate(schema, parse(source));
    assert.deepEqual(
      errors.map((e) => e.message),
      [],
      `${name}`,
    );
  }
});
