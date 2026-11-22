import { defineMcpTool } from "@nuxtjs/mcp-toolkit/server";
import { handoffShape } from "../../utils/events";
import { agentIdOf, handleHandoff } from "../../utils/tools";

export default defineMcpTool({
  description:
    "リセッション（session の再起動）の引継ぎを eventId で引き、本文をそのまま返す（抽出・要約を通さない）。自分の agent の分だけ。eventId は再起動後の最初の入力に書いてある。",
  inputSchema: handoffShape,
  annotations: { readOnlyHint: true },
  handler: async (args, extra) => handleHandoff(agentIdOf(extra), args),
});
