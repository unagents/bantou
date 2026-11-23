import { createSchema } from "graphql-yoga";
import type { GraphQLSchema } from "graphql";
import { resolvers } from "./resolvers/index.js";
import { mutationTypeDefs } from "./schema-mutation.js";
import { queryTypeDefs } from "./schema-query.js";
import { typeDefs } from "./schema-types.js";
import { subscriptionTypeDefs } from "./schema-subscription.js";

/** center の GraphQL schema（SDL は schema-*.ts、resolver は resolvers/*.ts）。 */
export function buildSchema(): GraphQLSchema {
  return createSchema({
    typeDefs: [typeDefs, queryTypeDefs, mutationTypeDefs, subscriptionTypeDefs],
    // resolver が schema に無い field を指していたら起動時に落とす（resolver の取りこぼしを test 以前に検出する）
    resolverValidationOptions: { requireResolversToMatchSchema: "error" },
    resolvers: resolvers as never,
  });
}
