import { GraphQLScalarType } from "graphql";
import { enumValues } from "./enums.js";
import { mutationResolvers } from "./mutation.js";
import { queryResolvers } from "./query.js";
import { subscriptionResolvers } from "./subscription.js";

/** 任意の JSON 値をそのまま通す scalar。 */
const JSONScalar = new GraphQLScalarType({
  name: "JSON",
  serialize: (v) => v,
  parseValue: (v) => v,
  parseLiteral: (ast): unknown => {
    switch (ast.kind) {
      case "StringValue":
      case "BooleanValue":
        return ast.value;
      case "IntValue":
      case "FloatValue":
        return Number(ast.value);
      case "NullValue":
        return null;
      case "ListValue":
        return ast.values.map((v) => JSONScalar.parseLiteral(v, undefined));
      case "ObjectValue":
        return Object.fromEntries(ast.fields.map((f) => [f.name.value, JSONScalar.parseLiteral(f.value, undefined)]));
      default:
        return undefined;
    }
  },
});

/** schema に渡す resolver 全体。query / mutation / subscription は別 file（並行で埋める）。 */
export const resolvers = {
  JSON: JSONScalar,
  ...enumValues,
  Query: queryResolvers,
  Mutation: mutationResolvers,
  Subscription: subscriptionResolvers,
};
