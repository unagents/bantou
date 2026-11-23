import { getTransport } from "~/tauri";
import { createGraphqlClient, type GraphqlClient } from "./graphql-client";

// The one GraphQL client of the screens. Where it sends is the seam's business (`getTransport().graphqlTarget()`:
// desktop = the center in use with its Bearer header, web = the backend's `/api/graphql`).
export const graphql: GraphqlClient = createGraphqlClient({ target: () => getTransport().graphqlTarget() });

export { GraphqlError } from "./graphql-client";
