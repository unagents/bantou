/**
 * The guardrail settings form: openspec's schema definitions (name → definition), kept in the center-wide settings
 * (`guardrailSchemas`). bantou does not read a definition: the form edits it as text and saves it as the JSON value it is.
 */

/** A schema's name: part of the `/schemas/[schema-name]` path, so letters, digits, `_` and `-` only (same rule as the center). */
export const GUARDRAIL_SCHEMA_NAME = /^[A-Za-z0-9_-]+$/;

/** One row of the form. `saved` rows exist on the center: their name is fixed (to rename, delete and add). */
export interface GuardrailRow {
  name: string;
  /** The definition as JSON text. */
  text: string;
  saved: boolean;
}

const isRec = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** The rows for the `guardrailSchemas` the center returned (by name; a value that is null is not a definition). */
export const guardrailDraftOf = (schemas: unknown): GuardrailRow[] =>
  isRec(schemas)
    ? Object.keys(schemas)
        .filter((name) => schemas[name] !== null && schemas[name] !== undefined)
        .sort()
        .map((name) => ({ name, text: JSON.stringify(schemas[name], null, 2), saved: true }))
    : [];

/** A copy of the rows (the baseline must not follow edits of the draft). */
export const cloneGuardrailDraft = (rows: GuardrailRow[]): GuardrailRow[] => rows.map((r) => ({ ...r }));

/** The definition typed in a row: JSON text. Null is refused (on the center `null` means delete; there is a delete button). */
function parseText(text: string): { value: unknown } | { error: string } {
  if (!text.trim()) return { error: "中身が空" };
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch (e) {
    return { error: `JSON として読めない: ${String(e)}` };
  }
  if (v === null) return { error: "null は定義にできない（消すには削除する）" };
  return { value: v };
}

/** Problem with the rows, or null. */
export function guardrailDraftError(rows: GuardrailRow[]): string | null {
  const seen = new Set<string>();
  for (const r of rows) {
    const label = r.name || "（名前なし）";
    if (!GUARDRAIL_SCHEMA_NAME.test(r.name)) return `schema の名前は英数字と _ - のみ: ${label}`;
    if (seen.has(r.name)) return `schema の名前が重なっている: ${r.name}`;
    seen.add(r.name);
    const p = parseText(r.text);
    if ("error" in p) return `schema ${r.name}: ${p.error}`;
  }
  return null;
}

/**
 * The update body for `guardrailSchemas` (merged by name on the center): a row that is new or whose text changed → its value,
 * a saved row that is gone → null. `null` when nothing changed. Call it only when `guardrailDraftError` is null.
 */
export function guardrailUpdate(rows: GuardrailRow[], base: GuardrailRow[]): Record<string, unknown> | null {
  const out: Record<string, unknown> = {};
  const was = new Map(base.map((r) => [r.name, r.text]));
  for (const r of rows) {
    if (was.get(r.name) === r.text) continue;
    const p = parseText(r.text);
    if ("value" in p) out[r.name] = p.value;
  }
  const names = new Set(rows.map((r) => r.name));
  for (const r of base) if (!names.has(r.name)) out[r.name] = null;
  return Object.keys(out).length ? out : null;
}
