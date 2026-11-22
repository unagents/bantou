import { defineTask } from "nitropack/runtime";
import { runGraphitiTask } from "../../utils/graphiti-task";

// Outbox の行を Graphiti（公式の MCP server）へ反映する。GRAPHITI_MCP_URL が無ければ何もしない。
// 抽出（memory:extract）・埋め込み（memory:embed）とは別の task。配線は server/utils/graphiti-task.ts。
export default defineTask({
  meta: { name: "memory:graphiti", description: "Outbox の行を Graphiti に反映する" },
  async run() {
    return { result: await runGraphitiTask() };
  },
});
