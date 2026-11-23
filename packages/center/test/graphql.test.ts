import assert from "node:assert/strict";
import { request } from "node:http";
import { test } from "node:test";
import { GraphQLObjectType } from "graphql";
import { startHttpServer } from "../src/http.js";
import { createCore } from "../src/core.js";
import { createEventHub } from "../src/events.js";
import { parseConfig } from "../src/config.js";
import { createGraphqlHandler } from "../src/graphql/server.js";
import { buildSchema } from "../src/graphql/schema.js";
import type { GraphqlServices } from "../src/graphql/context.js";
import { createCenterServer } from "../src/server.js";
import type { RemoteControlSupervisor } from "../src/remote-control.js";
import type { ServerLink } from "../src/server-link.js";
import type { SessionManager } from "../src/sessions.js";
import type { RemoteManager } from "../src/remotes.js";

const TOKEN = "test-token-0123456789";
const AUTH = { authorization: `Bearer ${TOKEN}` };

/** 設計書 3.1〜3.3 の表（変更後の名前）。schema がこれを漏れなく持つ事を確かめる。 */
const QUERY_FIELDS = [
  "sessions", "session", "sessionSettings", "centerSettings", "centerInfo", "centerVersion", "remotes", "servers", "rcStatus", "terminalOutputSince",
];
const MUTATION_FIELDS = [
  "createSession", "updateSession", "sleepSession", "wakeSession", "updateSessionSettings", "updateCenterSettings", "startSessionLogin", "submitSessionLoginCode",
  "restartSession", "replyWorker","terminalInput", "terminalResize", "attachToSession",
];
const SUBSCRIPTION_FIELDS = ["sessionsChanged", "sessionMessage", "terminalOutput", "remotesChanged", "centerStatus"];

async function boot(extra: { bind?: string; withGraphql?: boolean } = {}) {
  const config = parseConfig({}, "/tmp/c.json");
  const core = createCore();
  const events = createEventHub();
  const services = {
    config,
    supervisor: { list: () => [], shutdown: async () => {} } as unknown as RemoteControlSupervisor,
    link: {} as unknown as ServerLink,
    sessions: {} as unknown as SessionManager,
    remotes: {} as unknown as RemoteManager,
    login: undefined,
    core,
    events,
    log: () => {},
  } as unknown as GraphqlServices;
  const h = await startHttpServer({
    createServer: () => createCenterServer({ config, supervisor: services.supervisor, link: services.link, sessions: services.sessions, remotes: services.remotes }),
    ...(extra.withGraphql === false ? {} : { graphql: createGraphqlHandler(services, () => {}) }),
    core,
    events,
    port: 0,
    bind: extra.bind ?? "127.0.0.1",
    token: TOKEN,
    log: () => {},
  });
  return { h, url: `http://127.0.0.1:${h.port}/graphql` };
}

const gql = (url: string, query: string, headers: Record<string, string> = AUTH, extra: Record<string, string> = {}) =>
  fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers, ...extra }, body: JSON.stringify({ query }) });

test("graphql: token 無し・違う token は 401、token 付きは応答する", async () => {
  const { h, url } = await boot();
  try {
    assert.equal((await gql(url, "{__typename}", {})).status, 401);
    assert.equal((await gql(url, "{__typename}", { authorization: "Bearer wrong-token-0123456789" })).status, 401);
    const r = await gql(url, "{__typename}");
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { data: { __typename: "Query" } });
    // GET も同じ認証の下
    assert.equal((await fetch(`${url}?query=%7B__typename%7D`)).status, 401);
    // 余分な / の path でも認証の下（素通りにならない）
    assert.equal((await fetch(url.replace("/graphql", "//graphql/"), { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status, 401);
  } finally {
    await h.close();
  }
});

test("graphql: preflight（OPTIONS）は token 無しで答え、中身は返さない（webview の fetch 用）。他の method は token 無しなら 401 のまま", async () => {
  const { h, url } = await boot();
  try {
    const r = await fetch(url, {
      method: "OPTIONS",
      headers: { origin: "tauri://localhost", "access-control-request-method": "POST", "access-control-request-headers": "authorization,content-type" },
    });
    assert.ok(r.status === 200 || r.status === 204, `status ${r.status}`);
    assert.ok(r.headers.get("access-control-allow-origin"));
    assert.match(r.headers.get("access-control-allow-headers") ?? "", /authorization/i);
    assert.equal(await r.text(), "");
    assert.equal((await fetch(url, { method: "POST", headers: { "content-type": "application/json", origin: "tauri://localhost" }, body: '{"query":"{__typename}"}' })).status, 401);
  } finally {
    await h.close();
  }
});

test("graphql: `//graphql`・`/graphql/` も受ける（req.url を正規化して yoga に渡す）", async () => {
  const { h, url } = await boot();
  try {
    for (const path of ["//graphql", "/graphql/", "//graphql/"]) {
      const r = await gql(url.replace("/graphql", path), "{__typename}");
      assert.equal(r.status, 200, path);
      assert.deepEqual(await r.json(), { data: { __typename: "Query" } }, path);
    }
    // query 付きの GET でも正規化の後に query が残る（`//graphql?query=…` は正規化が無いと yoga が 404 にする）
    for (const path of ["/graphql/", "//graphql", "//graphql/"]) {
      const g = await fetch(`${url.replace("/graphql", path)}?query=%7B__typename%7D`, { headers: AUTH });
      assert.equal(g.status, 200, `GET ${path}`);
      assert.deepEqual(await g.json(), { data: { __typename: "Query" } }, `GET ${path}`);
    }
  } finally {
    await h.close();
  }
});

test("graphql: 渡さなければ /graphql は無い（404）", async () => {
  const { h, url } = await boot({ withGraphql: false });
  try {
    assert.equal((await gql(url, "{__typename}")).status, 404);
  } finally {
    await h.close();
  }
});

test("graphql: loopback bind で Host が違えば 403（/events・core route と同じ。未決 #25 の推奨 A）", async () => {
  const { h } = await boot();
  try {
    const status = await new Promise<number>((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port: h.port, path: "/graphql", method: "POST", headers: { ...AUTH, host: "evil.example:80", "content-type": "application/json" } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on("error", reject);
      req.end("{}");
    });
    assert.equal(status, 403);
  } finally {
    await h.close();
  }
});

test("graphql: 今の /mcp は並べて動く（GraphQL を足しても変わらない）", async () => {
  const { h, url } = await boot();
  try {
    const mcp = url.replace("/graphql", "/mcp");
    assert.equal((await fetch(mcp, { method: "POST" })).status, 401);
    assert.equal((await gql(url, "{__typename}")).status, 200);
  } finally {
    await h.close();
  }
});

test("graphql schema: 3.1〜3.3 の表の項目が query / mutation / subscription に漏れなく有り、resolver が 1 対 1 で付く", () => {
  const schema = buildSchema();
  const fieldsOf = (t: GraphQLObjectType | null | undefined) => Object.keys(t?.getFields() ?? {}).sort();
  assert.deepEqual(fieldsOf(schema.getQueryType()), [...QUERY_FIELDS].sort());
  assert.deepEqual(fieldsOf(schema.getMutationType()), [...MUTATION_FIELDS].sort());
  assert.deepEqual(fieldsOf(schema.getSubscriptionType()), [...SUBSCRIPTION_FIELDS].sort());
  for (const f of Object.values(schema.getQueryType()!.getFields())) assert.equal(typeof f.resolve, "function", `Query.${f.name} の resolver`);
  for (const f of Object.values(schema.getMutationType()!.getFields())) assert.equal(typeof f.resolve, "function", `Mutation.${f.name} の resolver`);
  // sleepSession の説明は実装（resession.requestSleep: 引継ぎを頼んで受理して即返す。断りは理由つきの error）と合っている
  const sleepDesc = schema.getMutationType()!.getFields().sleepSession.description ?? "";
  assert.match(sleepDesc, /受理して即返す/);
  assert.match(sleepDesc, /引継ぎ/);
  assert.doesNotMatch(sleepDesc, /眠らせ終わるまで待って/);
  for (const f of Object.values(schema.getSubscriptionType()!.getFields())) assert.equal(typeof f.subscribe, "function", `Subscription.${f.name} の subscribe`);
});
