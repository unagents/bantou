// テスト用の center 役（別 process。broker は 1 process につき 1 peer しか持てないため）。
// 引数: broker URL。stdin の 1 行 = server へ送る JSON。server からの受信 text は stdout に 1 行ずつ出す。
import { createInterface } from "node:readline";
import { createMessengerClient } from "@unagents/messenger-client";

const url = process.argv[2];
const meta = { protocol: "bantou", version: process.argv[3] ?? "1.3.0" };
const client = createMessengerClient({
  env: { AGENT_MESSENGER_DISCOVERY: "off" },
  name: "test-center",
  brokers: [url],
  autoStartBroker: false,
  log: () => {},
});
client.onMessage((m) => {
  console.log(m.text.replace(/\n/g, " "));
});
await client.connect();
let serverId;
for (let i = 0; i < 100 && !serverId; i++) {
  const peers = await client.listPeers("all", { protocol: "bantou" });
  serverId = peers[0]?.id;
  if (!serverId) await new Promise((r) => setTimeout(r, 100));
}
if (!serverId) {
  console.error("server が見つからない");
  process.exit(1);
}
console.log(JSON.stringify({ ready: true }));
const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  void client.send(serverId, line, "pull", meta).catch((e) => console.error(String(e)));
});
rl.on("close", async () => {
  await client.close().catch(() => {});
  process.exit(0);
});
