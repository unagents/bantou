import { defineEventHandler, toWebRequest } from "h3";
import { handleMcpRequest } from "../utils/bantou/mcp";

// worker 報告の受け口（MCP、Streamable HTTP）。実処理は utils/bantou/mcp.ts
export default defineEventHandler((event) => handleMcpRequest(toWebRequest(event)));
