import { GraphQLError } from "graphql";

/** 土台の stub が投げる error（後続の worker が resolver を埋めるまで）。extensions.code = NOT_IMPLEMENTED。 */
export function notImplemented(field: string): GraphQLError {
  return new GraphQLError(`not implemented: ${field}`, { extensions: { code: "NOT_IMPLEMENTED" } });
}
