import { RESERVED_MCP_NAMES, type Config } from "./config";

export interface ExtraMcpResult {
  /** mcp.json の mcpServers に足す stdio 定義。 */
  servers: Record<string, { type: "stdio"; command: string; args: string[]; env?: Record<string, string> }>;
  /** `--allowedTools` に足す（server 単位 `mcp__<name>`）。 */
  allowedTools: string[];
}

/**
 * 追加の stdio MCP のうち、`kind`（cap / worker）に載せる物を組み立てる。
 * 予約名（server 自身の MCP）と同名の物は既存を優先して捨て、警告を出す（loadConfig でも拒否済みの二重の備え）。
 */
export function buildExtraMcp(extra: NonNullable<Config["extraMcp"]>, kind: "cap" | "worker", log: (m: string) => void = () => {}): ExtraMcpResult {
  const servers: ExtraMcpResult["servers"] = {};
  const allowedTools: string[] = [];
  for (const [name, def] of Object.entries(extra)) {
    if (!def.targets.includes(kind)) continue;
    if ((RESERVED_MCP_NAMES as readonly string[]).includes(name)) {
      log(`extraMcp ${name} は server の MCP と名前が衝突するので載せない`);
      continue;
    }
    servers[name] = {
      type: "stdio",
      command: def.command,
      args: [...def.args],
      ...(Object.keys(def.env).length > 0 ? { env: { ...def.env } } : {}),
    };
    allowedTools.push(`mcp__${name}`);
  }
  return { servers, allowedTools };
}
