import { GraphQLError } from "graphql";
import type { GraphqlContext } from "../context.js";
import { packageVersion } from "../../server.js";
import { SESSION_NAME } from "../../sessions.js";
import { describeSystemInstructions } from "../../system-instructions.js";

/**
 * Query の resolver。schema-query.ts の field と 1 対 1。
 * center の service（ctx.services）を、MCP の道具（tools.ts）と同じ関数・同じ引数で呼ぶ。
 * 決定 6: launcher 鍵で守っていた項目（memory / mcpServers など）も絞らずに返す（`withoutLauncherKeys` を通さない）。
 */
type Resolver = (parent: unknown, args: Record<string, unknown>, ctx: GraphqlContext) => unknown;

/** service が投げた Error は message ごと client に返す（MCP の道具の `{ error }` と同じ。包まないと mask されて message が消える）。 */
function fail(e: unknown): never {
  if (e instanceof GraphQLError) throw e;
  throw new GraphQLError(e instanceof Error ? e.message : String(e));
}

/** MCP の道具の `z.string().regex(SESSION_NAME)` と同じ検査。 */
function checkSessionName(name: string): string {
  if (!SESSION_NAME.test(name)) throw new GraphQLError("session の名前は英数字と _ - のみ");
  return name;
}

export const queryResolvers: Record<string, Resolver> = {
  // session_list。reachable / reason は「desktop が center に聞けたか」の印で、GraphQL に届いた時点で聞けている
  sessions: (_p, _a, { services }) => ({ sessions: services.sessions.list(), reachable: true, reason: null }),

  session: (_p, args, { services }) => services.sessions.list().find((s) => s.name === args.name) ?? null,

  sessionSettings: (_p, args, { services }) => {
    try {
      return services.sessions.getSettings(checkSessionName(String(args.name))).settings;
    } catch (e) {
      return fail(e);
    }
  },

  centerSettings: (_p, _a, { services }) => services.sessions.getCenterSettings().settings,

  // center_info。launcher は返さない（決定 6）
  centerInfo: (_p, _a, { services }) => ({
    workspace: services.config.workspace ?? null,
    systemInstructions: describeSystemInstructions(),
  }),

  centerVersion: () => ({ version: packageVersion() }),

  // remote_list（owner を付けない呼び出し = 全件）
  remotes: (_p, _a, { services }) => services.remotes.list({}),

  // broker に protocol「bantou」で登録されている peer（ServerLink.listServers = listPeers(protocol: "bantou")）。version は server-info の答えの控え
  servers: async (_p, _a, { services }) => {
    try {
      return (await services.link.listServers()).map((s) => ({
        name: s.name,
        host: s.host,
        protocol: s.protocol,
        lastSeen: s.last_seen,
        version: services.link.serverVersionOf(s.name) ?? null,
      }));
    } catch (e) {
      return fail(e);
    }
  },

  rcStatus: (_p, _a, { services }) => services.supervisor.list(),

  // GET /sessions/<n>/output?after= の取り直し。購読は同期で続きを渡すので、集めてすぐ外す
  terminalOutputSince: (_p, args, { services }) => {
    const name = checkSessionName(String(args.session));
    const after = typeof args.after === "number" ? args.after : undefined;
    const chunks: { id: number; data: string }[] = [];
    let reset = false;
    const unsub = services.core.subscribe(name, after, (ev) => {
      if (ev.type === "reset") reset = true;
      else if (ev.type === "chunk") chunks.push({ id: ev.id, data: ev.data.toString("base64") });
    });
    if (!unsub) throw new GraphQLError("未定義の session");
    unsub();
    return { chunks, reset };
  },
};
