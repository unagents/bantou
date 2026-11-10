import { defineEventHandler, getHeader, setResponseStatus } from "h3";
import { authenticate } from "../utils/auth";

// /mcp への全 request を認証する。失敗理由は response に出さない（token の推測材料にしない）
export default defineEventHandler((event) => {
  const path = event.path.split("?")[0] ?? "";
  if (path !== "/mcp" && !path.startsWith("/mcp/")) return;
  const r = authenticate(process.env.MEMORY_TOKEN ?? "", (n) => getHeader(event, n));
  if (!r.ok) {
    setResponseStatus(event, 401);
    return { error: "unauthorized" };
  }
  event.context.agentId = r.agentId;
});
