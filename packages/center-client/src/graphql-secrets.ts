// The web's view of the center's secrets in GraphQL answers (design 4 stage B, the read side of the web's guards).
// The center's settings carry values that are secrets: `mcpSecrets`, the auth of `memory` / `projectMemory`, the `headers` / `env` of
// `mcpServers`, and the headers / env / token values of the old `mcp` / `mcpConnections`. The answer keeps every item and drops only the value (`***`). A write that sends the masked form back
// (the screen saved what it was shown) is "unchanged" for that item. The desktop (the webview calls the center itself)
// does not pass through here.

import { Kind, parse, valueFromASTUntyped, visit } from "graphql";
import { isDeepStrictEqual } from "node:util";

export const MASK = "***";

/** The settings items whose values are masked in an answer to the web. */
export const SECRET_ITEMS: readonly string[] = ["memory", "projectMemory", "mcpServers", "mcpSecrets", "mcp", "mcpConnections"];
const items: ReadonlySet<string> = new Set(SECRET_ITEMS);

/** A key that holds an auth value (Bearer / token / Authorization and the like). */
const AUTH_KEY = /^(token|authorization|bearer|api[-_]?key|password|secret)$/i;
const isHeadersOrEnv = (k: string | undefined) => k !== undefined && /^(headers|env)$/i.test(k);

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Is the scalar at `path` (keys from the item's value) a secret? */
function isSecretPath(item: string, path: readonly string[]): boolean {
  if (item === "mcpSecrets") return true;
  if (item === "mcpServers") return isHeadersOrEnv(path[1]); // [server name, "headers" | "env", ...]
  if (item === "mcp" || item === "mcpConnections") return path.some((k) => isHeadersOrEnv(k) || AUTH_KEY.test(k)); // old settings: headers / env / token at any depth
  return isHeadersOrEnv(path[0]) || path.some((k) => AUTH_KEY.test(k)); // memory, projectMemory: a server def (or the old { url, token })
}

function walk(item: string, v: unknown, path: readonly string[], fn: (leaf: unknown) => unknown): unknown {
  if (Array.isArray(v)) return v.map((x, i) => walk(item, x, [...path, String(i)], fn));
  if (isObj(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(item, x, [...path, k], fn)]));
  if (v === null || v === undefined || v === "") return v;
  return isSecretPath(item, path) ? fn(v) : v;
}

/** The value of a settings item with its secret values replaced by `***` (the items stay). */
export const maskItem = (item: string, value: unknown): unknown => walk(item, value, [], () => MASK);

/** Does the value of a settings item hold a `***` where a secret value belongs? */
function hasMask(item: string, value: unknown): boolean {
  let found = false;
  walk(item, value, [], (leaf) => {
    if (leaf === MASK) found = true;
    return leaf;
  });
  return found;
}

/** The answer's key → settings item, for the keys the query gives (an alias can rename a field). */
function itemKeys(query: string): Map<string, string> {
  const keys = new Map<string, string>(SECRET_ITEMS.map((i) => [i, i]));
  try {
    visit(parse(query), {
      Field(node) {
        if (node.alias && items.has(node.name.value)) keys.set(node.alias.value, node.name.value);
      },
    });
  } catch {
    // an unreadable document was refused before; nothing more to learn here
  }
  return keys;
}

function maskAnswer(v: unknown, keys: ReadonlyMap<string, string>): unknown {
  if (Array.isArray(v)) return v.map((x) => maskAnswer(x, keys));
  if (!isObj(v)) return v;
  return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, keys.has(k) ? maskItem(keys.get(k)!, x) : maskAnswer(x, keys)]));
}

/** The center's JSON answer to `bodyText` with the secret values masked. Not JSON: as it is. */
export function maskGraphqlAnswer(bodyText: string, answer: string): string {
  let query: unknown;
  let json: unknown;
  try {
    query = (JSON.parse(bodyText) as { query?: unknown }).query;
    json = JSON.parse(answer);
  } catch {
    return answer;
  }
  return JSON.stringify(maskAnswer(json, itemKeys(typeof query === "string" ? query : "")));
}

/** What `fetchCurrent` is asked for: the settings of a session or of the center. */
export type SettingsRef = { kind: "session"; name: string } | { kind: "center" };

const SETTINGS_WRITERS: Readonly<Record<string, "session" | "center">> = { updateSessionSettings: "session", updateCenterSettings: "center" };

/**
 * A write that sends back a secret item exactly as the web was shown it (the masked form of the current value) changes
 * nothing for that item: it is dropped from the input (the rest of the update goes on). Anything else (a value
 * changed, no current value to compare with) is left as it is, and the center-only refusal applies to it as before.
 * Only a settings passed as a variable is looked at.
 */
export async function dropUnchangedSecrets(
  bodyText: string,
  fetchCurrent: (ref: SettingsRef) => Promise<Record<string, unknown> | undefined>,
): Promise<string> {
  let json: Record<string, unknown>;
  let doc;
  try {
    json = JSON.parse(bodyText) as Record<string, unknown>;
    if (!isObj(json) || typeof json.query !== "string") return bodyText;
    doc = parse(json.query);
  } catch {
    return bodyText;
  }
  const variables: Record<string, unknown> = isObj(json.variables) ? { ...json.variables } : {};
  let changed = false;
  for (const def of doc.definitions) {
    if (def.kind !== Kind.OPERATION_DEFINITION || def.operation !== "mutation") continue;
    for (const sel of def.selectionSet.selections) {
      if (sel.kind !== Kind.FIELD) continue;
      const writer = SETTINGS_WRITERS[sel.name.value];
      const arg = sel.arguments?.find((a) => a.name.value === "settings");
      if (!writer || arg?.value.kind !== Kind.VARIABLE) continue;
      const varName = arg.value.name.value;
      const input = variables[varName];
      if (!isObj(input)) continue;
      const sent = SECRET_ITEMS.filter((i) => hasMask(i, input[i]));
      if (sent.length === 0) continue;
      let ref: SettingsRef | undefined;
      if (writer === "center") ref = { kind: "center" };
      else {
        const name = sel.arguments?.find((a) => a.name.value === "name");
        const n = name ? valueFromASTUntyped(name.value, variables) : undefined;
        if (typeof n === "string") ref = { kind: "session", name: n };
      }
      const current = ref ? await fetchCurrent(ref) : undefined;
      if (!current) continue;
      const rest = { ...input };
      for (const i of sent) if (isDeepStrictEqual(input[i], maskItem(i, current[i]))) delete rest[i];
      variables[varName] = rest;
      changed = true;
    }
  }
  return changed ? JSON.stringify({ ...json, variables }) : bodyText;
}
