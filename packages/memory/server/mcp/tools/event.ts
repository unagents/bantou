import { defineMcpTool } from "@nuxtjs/mcp-toolkit/server";
import { eventShape } from "../../utils/events";
import { agentIdOf, handleEvent } from "../../utils/tools";

export default defineMcpTool({
  description:
    "bantou の event（利用者の発言・応答・task・result・report・reply）を記憶に書き込む。eventId が同じ再送は無視される（冪等）。",
  inputSchema: eventShape,
  annotations: { readOnlyHint: false, idempotentHint: true },
  handler: async (args, extra) => handleEvent(agentIdOf(extra), args),
});
