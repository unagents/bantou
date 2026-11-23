/**
 * The guardrail settings form: openspec's schema definitions (name → { schema, templates }), kept in the center-wide settings
 * (`guardrailSchemas`). bantou does not read a definition: the schema (YAML) and each template are edited as text and saved as the strings they are.
 */

/** A schema's name: part of the `/schemas/[schema-name]` path (same rule as the center; case-sensitive). */
export const GUARDRAIL_SCHEMA_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** One template file of a schema: its path relative to `templates/` and its content. */
export interface GuardrailTemplate {
  path: string;
  body: string;
}

/** One row of the form. `saved` rows exist on the center: their name is fixed (to rename, delete and add). */
export interface GuardrailRow {
  name: string;
  /** schema.yaml as text (not read). */
  schema: string;
  templates: GuardrailTemplate[];
  saved: boolean;
}

const isRec = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** A template's path: relative to `templates/` (same rule as the center): not empty, no empty / `.` / `..` part between `/`, no `\` or NUL. */
export function isTemplatePath(p: string): boolean {
  if (p === "" || p.includes("\\") || p.includes("\0")) return false;
  return p.split("/").every((seg) => seg !== "" && seg !== ".." && seg !== ".");
}

/** The templates of one definition as the center returned them (a record of path → string), or null if it is not that. */
function templatesOf(v: unknown): GuardrailTemplate[] | null {
  if (!isRec(v)) return null;
  const out: GuardrailTemplate[] = [];
  for (const path of Object.keys(v).sort()) {
    const body = v[path];
    if (typeof body !== "string") return null;
    out.push({ path, body });
  }
  return out;
}

/** The rows for the `guardrailSchemas` the center returned (by name; a value that is not `{ schema, templates }` is dropped). */
export const guardrailDraftOf = (schemas: unknown): GuardrailRow[] => {
  if (!isRec(schemas)) return [];
  const rows: GuardrailRow[] = [];
  for (const name of Object.keys(schemas).sort()) {
    const v = schemas[name];
    if (!isRec(v) || typeof v.schema !== "string") continue;
    const templates = templatesOf(v.templates === undefined ? {} : v.templates);
    if (templates) rows.push({ name, schema: v.schema, templates, saved: true });
  }
  return rows;
};

/** A copy of the rows (the baseline must not follow edits of the draft). */
export const cloneGuardrailDraft = (rows: GuardrailRow[]): GuardrailRow[] => rows.map((r) => ({ ...r, templates: r.templates.map((t) => ({ ...t })) }));

/** Problem with the rows, or null. */
export function guardrailDraftError(rows: GuardrailRow[]): string | null {
  const seen = new Set<string>();
  for (const r of rows) {
    const label = r.name || "（名前なし）";
    if (!GUARDRAIL_SCHEMA_NAME.test(r.name)) return `schema の名前は英数字で始まり、英数字と . _ - のみ: ${label}`;
    if (seen.has(r.name)) return `schema の名前が重なっている: ${r.name}`;
    seen.add(r.name);
    const paths = new Set<string>();
    for (const t of r.templates) {
      if (!isTemplatePath(t.path)) return `schema ${r.name}: template の path は templates/ からの相対 path（空・先頭の /・. や .. や空の区間・\\ を含まない）: ${t.path || "（空）"}`;
      if (paths.has(t.path)) return `schema ${r.name}: template の path が重なっている: ${t.path}`;
      paths.add(t.path);
    }
  }
  return null;
}

/** The definition of a row as the center takes it (`templates` always sent: a definition is replaced as a whole). */
const definitionOf = (r: GuardrailRow): { schema: string; templates: Record<string, string> } => ({
  schema: r.schema,
  // fromEntries makes own properties (a path `__proto__` stays a key)
  templates: Object.fromEntries(r.templates.map((t) => [t.path, t.body])),
});

/**
 * The update body for `guardrailSchemas` (merged by name on the center): a row that is new or whose definition changed → `{ schema, templates }`,
 * a saved row that is gone → null. `null` when nothing changed. Call it only when `guardrailDraftError` is null.
 */
export function guardrailUpdate(rows: GuardrailRow[], base: GuardrailRow[]): Record<string, { schema: string; templates: Record<string, string> } | null> | null {
  const out: Record<string, { schema: string; templates: Record<string, string> } | null> = {};
  const was = new Map(base.map((r) => [r.name, JSON.stringify(definitionOf(r))]));
  for (const r of rows) {
    const d = definitionOf(r);
    if (was.get(r.name) === JSON.stringify(d)) continue;
    out[r.name] = d;
  }
  const names = new Set(rows.map((r) => r.name));
  for (const r of base) if (!names.has(r.name)) out[r.name] = null;
  return Object.keys(out).length ? out : null;
}
