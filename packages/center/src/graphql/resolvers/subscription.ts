import type { GraphqlContext } from "../context.js";
import { notImplemented } from "./not-implemented.js";

/**
 * Subscription の resolver（ga-sub が埋める）。schema-subscription.ts の field と 1 対 1。
 * subscribe は AsyncIterable を返し、resolve（省略可）が payload を整える。stub は subscribe で NOT_IMPLEMENTED を投げる。
 * 端末の購読は core.ts の subscribe（after / reset / end）に依存するので terminalOutput は 1 人でまとめて埋める。
 */
interface SubscriptionField {
  subscribe: (parent: unknown, args: Record<string, unknown>, ctx: GraphqlContext) => AsyncIterable<unknown> | Promise<AsyncIterable<unknown>>;
  resolve?: (payload: unknown, args: Record<string, unknown>, ctx: GraphqlContext) => unknown;
}

const stub = (field: string): SubscriptionField => ({
  subscribe: () => {
    throw notImplemented(field);
  },
});

export const subscriptionResolvers: Record<string, SubscriptionField> = {
  sessionsChanged: stub("Subscription.sessionsChanged"),
  sessionMessage: stub("Subscription.sessionMessage"),
  terminalOutput: stub("Subscription.terminalOutput"),
  remotesChanged: stub("Subscription.remotesChanged"),
  centerStatus: stub("Subscription.centerStatus"),
};
