import { createError, defineEventHandler, getHeader, setResponseStatus } from "h3";
import { authenticate } from "../utils/auth";

// /mcp への全 request を認証する。失敗理由は response に出さない（token の推測材料にしない）
// /mcp 以外の path は 404（UI を持たないので SPA shell を返さない）
export default defineEventHandler((event) => {
  const path = event.path.split("?")[0] ?? "";
  if (path !== "/mcp" && !path.startsWith("/mcp/")) {
    throw createError({ statusCode: 404, statusMessage: "Not Found" });
  }
  const r = authenticate(process.env.MEMORY_TOKEN ?? "", (n) => getHeader(event, n));
  if (!r.ok) {
    setResponseStatus(event, 401);
    return { error: "unauthorized" };
  }
  event.context.agentId = r.agentId;
});
