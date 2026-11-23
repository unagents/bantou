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
  "sessions", "session", "sessionSettings", "centerSettings", "centerInfo", "centerVersion", "remotes", "servers", "serverPeers", "rcStatus", "terminalOutputSince",
];
const MUTATION_FIELDS = [
  "createSession", "updateSession", "sleepSession", "wakeSession", "updateSessionSettings", "updateCenterSettings", "startSessionLogin", "submitSessionLoginCode",
  "restartSession", "replyWorker", "retireServer", "terminalInput", "terminalResize", "attachToSession",
];
const SUBSCRIPTION_FIELDS = ["sessionsChanged", "sessionMessage", "terminalOutput", "remotesChanged", "centerStatus"];

async function boot(extra: { bind?: string; withGraphql?: boolean } = {}) {
  const config = parseConfig({}, "/tmp/c.json");
  const core = createCore();
  const events = createEventHub();
  const services = {
    config,
    supervisor: { list: () => [], shutdown: async () => {} } as unknown as RemoteControlSupervisor,
    link: { list: async () => [] } as unknown as ServerLink,
    sessions: {} as unknown as SessionManager,
    remotes: {} as unknown as RemoteManager,
    follow: undefined,
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
  for (const f of Object.values(schema.getSubscriptionType()!.getFields())) assert.equal(typeof f.subscribe, "function", `Subscription.${f.name} の subscribe`);
});

test("graphql: 土台の stub は NOT_IMPLEMENTED を返す（query・subscription(SSE)。mutation は実装済み: graphql-mutation.test.ts）", async () => {
  const { h, url } = await boot();
  try {
    const q = (await (await gql(url, "{sessions{reachable}}")).json()) as { errors: { message: string; extensions: { code: string } }[] };
    assert.equal(q.errors[0].extensions.code, "NOT_IMPLEMENTED");
    assert.match(q.errors[0].message, /Query\.sessions/);
    const s = await gql(url, "subscription{sessionMessage{session}}", AUTH, { accept: "text/event-stream" });
    assert.equal(s.status, 200);
    assert.match(s.headers.get("content-type") ?? "", /text\/event-stream/);
    assert.match(await s.text(), /NOT_IMPLEMENTED/);
  } finally {
    await h.close();
  }
});
