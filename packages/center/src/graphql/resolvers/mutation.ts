import type { GraphqlContext } from "../context.js";
import { notImplemented } from "./not-implemented.js";

/**
 * Mutation の resolver（ga-mutation が埋める）。schema-mutation.ts の field と 1 対 1。
 * stub は NOT_IMPLEMENTED を投げる。埋める時は stub を置き換える。
 */
type Resolver = (parent: unknown, args: Record<string, unknown>, ctx: GraphqlContext) => unknown;

export const mutationResolvers: Record<string, Resolver> = {
  createSession: () => {
    throw notImplemented("Mutation.createSession");
  },
  updateSession: () => {
    throw notImplemented("Mutation.updateSession");
  },
  sleepSession: () => {
    throw notImplemented("Mutation.sleepSession");
  },
  wakeSession: () => {
    throw notImplemented("Mutation.wakeSession");
  },
  updateSessionSettings: () => {
    throw notImplemented("Mutation.updateSessionSettings");
  },
  updateCenterSettings: () => {
    throw notImplemented("Mutation.updateCenterSettings");
  },
  startSessionLogin: () => {
    throw notImplemented("Mutation.startSessionLogin");
  },
  submitSessionLoginCode: () => {
    throw notImplemented("Mutation.submitSessionLoginCode");
  },
  restartSession: () => {
    throw notImplemented("Mutation.restartSession");
  },
  replyWorker: () => {
    throw notImplemented("Mutation.replyWorker");
  },
  retireServer: () => {
    throw notImplemented("Mutation.retireServer");
  },
  terminalInput: () => {
    throw notImplemented("Mutation.terminalInput");
  },
  terminalResize: () => {
    throw notImplemented("Mutation.terminalResize");
  },
  attachToSession: () => {
    throw notImplemented("Mutation.attachToSession");
  },
};
