import { createCenterClient, type CenterClient } from "bantou-center-client";

let cached: CenterClient | undefined;

/** center とつなぐ部品一式。process で 1 回だけ組んで使い回す（全ブラウザで 1 本の MCP session / events） */
export function getCenterClient(): CenterClient {
  cached ??= createCenterClient({
    logger: {
      info: (m) => console.info(`[center] ${m}`),
      warn: (m) => console.warn(`[center] ${m}`),
    },
  });
  return cached;
}
