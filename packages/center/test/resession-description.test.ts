import assert from "node:assert/strict";
import { test } from "node:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerSessionTools } from "../src/tools.js";

test("session_resession の description（v2）: center が本文（取り出せない時はその事と置き場）を最初の入力で渡す。id を知らせる旧い説明は無い。inputSchema は handoff のまま", async () => {
  const server = new McpServer({ name: "t", version: "0" });
  registerSessionTools(server, { remotes: {} as never, owner: "pm1", resession: { request: async () => ({ accepted: true, handoff_id: "h", stored: "memory", restart: "x" }) } });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: "c", version: "0" });
  await client.connect(b);
  const t = (await client.listTools()).tools.find((x) => x.name === "session_resession")!;
  const d = t.description ?? "";
  for (const w of ["center が引継ぎの本文", "取り出せなかった時はその事と置き場", "どちらも center が保存先から取り出して渡す", "stored"]) assert.ok(d.includes(w), w);
  assert.ok(!d.includes("引継ぎの id が知らされる"));
  assert.deepEqual(Object.keys((t.inputSchema as { properties: object }).properties), ["handoff"]);
});
