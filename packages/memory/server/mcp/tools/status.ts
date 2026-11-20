import { defineMcpTool } from "@nuxtjs/mcp-toolkit/server";
import { agentIdOf, handleStatus } from "../../utils/tools";

export default defineMcpTool({
  description:
    "外部記憶の状態を返す（記憶の件数、抽出待ちの event、埋め込み待ちの件数、最後に成功した抽出と埋め込みの時刻、dead-letter の件数、直近の error の要旨）。自分の agent の分だけ。本文は返さない。",
  inputSchema: {},
  annotations: { readOnlyHint: true },
  handler: async (_args, extra) => handleStatus(agentIdOf(extra)),
});
