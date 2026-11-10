import { defineMcpTool } from "@nuxtjs/mcp-toolkit/server";
import { recallShape } from "../../utils/recall";
import { agentIdOf, handleRecall } from "../../utils/tools";

export default defineMcpTool({
  description:
    "長期記憶を検索する。結果は出典 event ID・確定状態（confirmed / verified / inferred / superseded）・有効期間付き。既定は確定情報のみ（includeInferred で推測も含める）。",
  inputSchema: recallShape,
  annotations: { readOnlyHint: true },
  handler: async (args, extra) => handleRecall(agentIdOf(extra), args),
});
