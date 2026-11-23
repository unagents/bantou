// What the web backend lets through to the center's `/graphql` (the web's old guards, kept for GraphQL):
// the mutations the web may call (the same basis as `WEB_ALLOWED_TOOLS`) and no write of the center-only settings
// (`CENTER_ONLY_KEYS`). Anything that cannot be checked is refused. Queries and subscriptions are read-only and pass.

import { Kind, parse, valueFromASTUntyped, type FieldNode, type OperationDefinitionNode } from "graphql";
import { CENTER_ONLY_REFUSAL, hasCenterOnlyKey } from "./tool-policy.ts";

/**
 * The mutations the web may call. `WEB_ALLOWED_TOOLS` minus what the web UI no longer uses (`replyWorker`: a worker's
 * question goes to the cap directly in v2). Not here on purpose: any session deletion (the desktop UI does not use it).
 */
export const WEB_ALLOWED_MUTATIONS: readonly string[] = [
  "createSession",
  "updateSession",
  "sleepSession",
  "wakeSession",
  "updateSessionSettings",
  "updateCenterSettings",
  "startSessionLogin",
  "submitSessionLoginCode",
  "restartSession",
  "terminalInput",
  "terminalResize",
  "attachToSession",
];
const allowed = new Set(WEB_ALLOWED_MUTATIONS);

/** Mutations whose `settings` argument can carry a center-only key. */
const SETTINGS_MUTATIONS: ReadonlySet<string> = new Set(["createSession", "updateSessionSettings", "updateCenterSettings"]);

export interface GuardRefusal {
  status: number;
  message: string;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** The reason a POST body is refused, or undefined to forward it. Holds no value of the request. */
export function graphqlRefusal(bodyText: string): GuardRefusal | undefined {
  let json: unknown;
  try {
    json = JSON.parse(bodyText);
  } catch {
    return { status: 400, message: "body は JSON で渡す" };
  }
  if (!isObj(json) || typeof json.query !== "string") return { status: 400, message: "body は query を持つ JSON のオブジェクトで渡す" };
  const variables = isObj(json.variables) ? json.variables : {};
  let doc;
  try {
    doc = parse(json.query);
  } catch {
    return { status: 400, message: "GraphQL の document として読めない" };
  }
  // every mutation in the document is checked, whichever `operationName` selects
  for (const def of doc.definitions) {
    if (def.kind !== Kind.OPERATION_DEFINITION || def.operation !== "mutation") continue;
    const r = mutationRefusal(def, variables);
    if (r) return r;
  }
  return undefined;
}

function mutationRefusal(op: OperationDefinitionNode, variables: Record<string, unknown>): GuardRefusal | undefined {
  for (const sel of op.selectionSet.selections) {
    // a fragment at the root could bring in a field not checked here
    if (sel.kind !== Kind.FIELD) return { status: 403, message: "mutation の直下に fragment は使えない" };
    const field: FieldNode = sel;
    const name = field.name.value;
    if (name === "__typename") continue;
    if (!allowed.has(name)) return { status: 403, message: `web からは呼べない mutation: ${name}` };
    if (!SETTINGS_MUTATIONS.has(name)) continue;
    const arg = field.arguments?.find((a) => a.name.value === "settings");
    if (!arg) continue;
    if (arg.value.kind === Kind.VARIABLE) {
      // a variable is looked at only with a value actually sent; a default (or no value at all) is not checked here, so it is refused
      const varName = arg.value.name.value;
      if (!Object.prototype.hasOwnProperty.call(variables, varName)) {
        return { status: 403, message: "settings の変数には variables で値を渡す（既定値だけの変数は使えない）" };
      }
      const def = op.variableDefinitions?.find((d) => d.variable.name.value === varName);
      if (def?.defaultValue) {
        const dv = valueFromASTUntyped(def.defaultValue, {});
        if (isObj(dv) && hasCenterOnlyKey(dv)) return { status: 403, message: CENTER_ONLY_REFUSAL };
      }
    } else if (arg.value.kind !== Kind.OBJECT) {
      continue; // null or another literal: no key to write
    }
    const v = valueFromASTUntyped(arg.value, variables);
    if (isObj(v) && hasCenterOnlyKey(v)) return { status: 403, message: CENTER_ONLY_REFUSAL };
  }
  return undefined;
}
