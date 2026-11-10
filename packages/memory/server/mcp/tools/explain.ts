import { defineMcpTool } from "@nuxtjs/mcp-toolkit/server";
import { explainShape } from "../../utils/recall";
import { agentIdOf, handleExplain } from "../../utils/tools";

export default defineMcpTool({
  description: "記憶 1 件の出典 event と検証状態を返す。",
  inputSchema: explainShape,
  annotations: { readOnlyHint: true },
  handler: async (args, extra) => handleExplain(agentIdOf(extra), args),
});
