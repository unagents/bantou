/**
 * schema の MCP server（schema-discovery のプロトコルに則る、center に内蔵の口）。
 *
 * guardrail の設定（center-settings.json の guardrailSchemas）の schema 定義を、MCP の resource として返す。
 * - resource template `schema:///schemas/{name}`。名前の規則は GUARDRAIL_SCHEMA_NAME（`[A-Za-z0-9][A-Za-z0-9._-]*`、大文字小文字を区別する）。
 * - `resources/list` は全件を 1 回の応答で返す（cursor 無し）。capability は resources だけ。
 * - `resources/read` の contents はちょうど 1 件: uri は要求 URI と完全一致、mimeType は application/json、
 *   text は `{"name", "schema"（schema.yaml の文字列）, "templates"（templates/ からの相対 path → 中身）}` の JSON。
 * - 無い名前・template に合っても規則外の名前（正規化して別の schema を返さない）・他の URI は JSON-RPC error -32002（data.uri）。
 * - transport は Streamable HTTP の stateless・JSON 応答の POST だけ（session・SSE は無い。http.ts が 1 リクエストごとに server と transport を作る）。
 * bantou は YAML の中身を解釈しない。
 */
import { createHmac } from "node:crypto";
import type { SchemaDiscovery } from "@agent-hand/bantou-protocol";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { ErrorCode, ListResourcesRequestSchema, ListResourceTemplatesRequestSchema, McpError, ReadResourceRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { readCached } from "./mcp-source.js";
import { GUARDRAIL_SCHEMA_NAME, guardrailSchemasOf, type GuardrailSchema } from "./project-settings.js";

/** center の http server でこの口を出す path。 */
export const SCHEMA_MCP_PATH = "/mcp/schemas";
/** resource の URI の前置き。後ろに名前が付く。 */
export const SCHEMA_URI_PREFIX = "schema:///schemas/";
/** resource template（プロトコルの正本）。 */
export const SCHEMA_URI_TEMPLATE = `${SCHEMA_URI_PREFIX}{name}`;
export const SCHEMA_MIME_TYPE = "application/json";
/** プロトコルの「無い時」の JSON-RPC error の code（MCP の resource not found）。 */
export const RESOURCE_NOT_FOUND = -32002;
/** center が openspec-mcp に渡す discovery header の名前。 */
export const SCHEMA_DISCOVERY_HEADER = "x-schema-discovery";
/** discovery header の値（JSON）を session の子 process の env に渡す変数名。`${BANTOU_SCHEMA_DISCOVERY}` と書いた header の値が claude の起動時に展開される。 */
export const SCHEMA_DISCOVERY_ENV = "BANTOU_SCHEMA_DISCOVERY";

/** 今の schema 定義（名前 → 中身）を返す関数。呼ぶたびに今の値を返す（center の再起動なしで足した・消した定義が反映される）。読めなければ空。 */
export type SchemaSource = () => Record<string, GuardrailSchema>;

/**
 * 設定 file から SchemaSource を作る。呼ぶたびに file を見て、変わった時だけ読み直す（mcp-source.ts と同じ読み方。center の再起動は要らない）。
 * file が無ければ空。壊れて読めない時も空（log に理由の種類だけ）。
 */
export function schemaSourceFromFile(settingsPath: string, log: (m: string) => void = () => {}): SchemaSource {
  const read = readCached<Record<string, GuardrailSchema>>(
    settingsPath,
    (raw) => {
      if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error("not object");
      return guardrailSchemasOf(raw);
    },
    {},
    log,
  );
  return () => {
    const r = read();
    return r.ok ? r.value : {};
  };
}

/**
 * schema の口の Bearer token。center の token（/mcp の全権）とは別の、読み取り専用の値を center の token から導く
 * （openspec-mcp に渡るのはこの値だけ。/mcp には使えない）。
 */
export const schemaTokenOf = (centerToken: string): string => createHmac("sha256", centerToken).update("bantou-schema-server/v1").digest("hex");

/** `x-schema-discovery` header の値（プロトコルの JSON 1 本。値は ASCII のみ）。 */
export function schemaDiscoveryValue(url: string, centerToken: string): string {
  return JSON.stringify(schemaDiscoveryOf(url, centerToken));
}

/** 同じ中身の object（launch の `schema`）。Authorization の値は log に出さない。 */
export function schemaDiscoveryOf(url: string, centerToken: string): SchemaDiscovery {
  return { type: "http", url, headers: { Authorization: `Bearer ${schemaTokenOf(centerToken)}` } };
}

/**
 * session の子 process の env に discovery header の値を置く（SCHEMA_DISCOVERY_ENV）。openspec-mcp の接続（設定の mcpServers の 1 件）の
 * headers に `"x-schema-discovery": "${BANTOU_SCHEMA_DISCOVERY}"` と書くと、claude の起動時にこの値へ展開される。
 * center が http で待ち受けていない時（port が null）・token が無い時は置かない。url は center が session から見える host と port で組み立てる。
 */
export function applySchemaDiscoveryEnv(env: Record<string, string>, o: { host: string; port: number | null; token: string | undefined }): void {
  if (o.port === null || !o.token) return;
  env[SCHEMA_DISCOVERY_ENV] = schemaDiscoveryValue(`http://${o.host}:${o.port}${SCHEMA_MCP_PATH}`, o.token);
}

/** URI から名前を取り出す。template に合い、名前が規則に合う時だけ。無ければ undefined（正規化・decode はしない）。 */
export function schemaNameOfUri(uri: string): string | undefined {
  if (!uri.startsWith(SCHEMA_URI_PREFIX)) return undefined;
  const name = uri.slice(SCHEMA_URI_PREFIX.length);
  return GUARDRAIL_SCHEMA_NAME.test(name) ? name : undefined;
}

const notFound = (uri: string): McpError => new McpError(RESOURCE_NOT_FOUND as ErrorCode, "Resource not found", { uri });

/** schema の MCP server を 1 つ作る（http.ts が 1 リクエストごとに呼ぶ）。 */
export function createSchemaServer(source: SchemaSource): Server {
  const server = new Server({ name: "bantou-schema", version: "1" }, { capabilities: { resources: {} } });
  server.setRequestHandler(ListResourcesRequestSchema, () => ({
    resources: Object.keys(source())
      .sort()
      .map((name) => ({ uri: `${SCHEMA_URI_PREFIX}${name}`, name, mimeType: SCHEMA_MIME_TYPE })),
  }));
  server.setRequestHandler(ListResourceTemplatesRequestSchema, () => ({
    resourceTemplates: [{ uriTemplate: SCHEMA_URI_TEMPLATE, name: "schema", mimeType: SCHEMA_MIME_TYPE }],
  }));
  server.setRequestHandler(ReadResourceRequestSchema, (req) => {
    const uri = req.params.uri;
    const name = schemaNameOfUri(uri);
    const all = source();
    if (name === undefined || !Object.hasOwn(all, name)) throw notFound(uri);
    const def = all[name]!;
    return { contents: [{ uri, mimeType: SCHEMA_MIME_TYPE, text: JSON.stringify({ name, schema: def.schema, templates: def.templates }) }] };
  });
  return server;
}
