import { defineMcpTool } from "@nuxtjs/mcp-toolkit/server";
import { contextShape } from "../../utils/recall";
import { agentIdOf, handleContext } from "../../utils/tools";

export default defineMcpTool({
  description: "判断用の要約を返す（利用者の方針、直近の決定、未回答の質問、進行中の task）。起動時と判断の前に呼ぶ。",
  inputSchema: contextShape,
  annotations: { readOnlyHint: true },
  handler: async (args, extra) => handleContext(agentIdOf(extra), args),
});
