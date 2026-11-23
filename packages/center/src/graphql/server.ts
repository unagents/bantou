import type { IncomingMessage, ServerResponse } from "node:http";
import { GraphQLError } from "graphql";
import { createYoga } from "graphql-yoga";
import { GRAPHQL_PATH } from "../http.js";
import type { Logger } from "../log.js";
import type { GraphqlContext, GraphqlServices } from "./context.js";
import { buildSchema } from "./schema.js";

/** http.ts が認証（今は Bearer）を済ませた後に呼ぶ、node:http の handler。 */
export type GraphqlHandler = (req: IncomingMessage, res: ServerResponse) => Promise<void>;

/** resolver が投げた GraphQLError そのもの（想定外の Error を包んだ物ではない）か。 */
function isOriginalGraphQLError(error: unknown): boolean {
  if (!(error instanceof Error) || error.name !== "GraphQLError") return false;
  const inner = (error as GraphQLError).originalError;
  return inner == null ? true : isOriginalGraphQLError(inner);
}

/**
 * GraphQL の endpoint（graphql-yoga。query・mutation は HTTP、subscription は SSE。設計書 #1 案 A）。
 * 静的 import にする（cli.ts の注記: bun build --compile で動的 import は依存を遅延初期化に包んで落ちる）。
 */
export function createGraphqlHandler(services: GraphqlServices, log: Logger): GraphqlHandler {
  const yoga = createYoga<{ req: IncomingMessage; res: ServerResponse }, GraphqlContext>({
    schema: buildSchema(),
    graphqlEndpoint: GRAPHQL_PATH,
    // 画面は無い。GraphiQL・landing page は出さない
    graphiql: false,
    landingPage: false,
    context: () => ({ services }),
    // yoga 自身の log は使わない（console に出る）。想定外の error は mask する時に center の log へ残す
    logging: false,
    maskedErrors: {
      maskError: (error, message) => {
        // resolver が意図して投げた GraphQLError（入力の誤り・NOT_IMPLEMENTED など）はそのまま client へ返す
        if (isOriginalGraphQLError(error)) return error as Error;
        log(`graphql error: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
        return new GraphQLError(message, { extensions: { code: "INTERNAL_SERVER_ERROR" } });
      },
    },
  });
  return async (req, res) => {
    await yoga(req, res);
  };
}
