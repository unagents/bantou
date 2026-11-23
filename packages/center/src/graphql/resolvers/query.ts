import type { GraphqlContext } from "../context.js";
import { notImplemented } from "./not-implemented.js";

/**
 * Query の resolver（ga-query が埋める）。schema-query.ts の field と 1 対 1。
 * stub は NOT_IMPLEMENTED を投げる。埋める時は stub を置き換える（field を足し引きしない。schema の変更は別に相談）。
 */
type Resolver = (parent: unknown, args: Record<string, unknown>, ctx: GraphqlContext) => unknown;

export const queryResolvers: Record<string, Resolver> = {
  sessions: () => {
    throw notImplemented("Query.sessions");
  },
  session: () => {
    throw notImplemented("Query.session");
  },
  sessionSettings: () => {
    throw notImplemented("Query.sessionSettings");
  },
  centerSettings: () => {
    throw notImplemented("Query.centerSettings");
  },
  centerInfo: () => {
    throw notImplemented("Query.centerInfo");
  },
  centerVersion: () => {
    throw notImplemented("Query.centerVersion");
  },
  remotes: () => {
    throw notImplemented("Query.remotes");
  },
  servers: () => {
    throw notImplemented("Query.servers");
  },
  serverPeers: () => {
    throw notImplemented("Query.serverPeers");
  },
  rcStatus: () => {
    throw notImplemented("Query.rcStatus");
  },
  terminalOutputSince: () => {
    throw notImplemented("Query.terminalOutputSince");
  },
};
