// テスト用の peer（center 役・cap 役。別 process。broker は 1 process につき 1 peer しか持てないため）。
// 引数: broker URL、登録する名前。
// stdin の 1 行 = {"to":"<名前>","text":"<本文>","meta":{...}|null}。meta 付きで送る時は meta を入れる（cap の返しは meta 無し）。
// 受信は {"from_name","text","meta"} を stdout に 1 行ずつ出す。接続できたら {"ready":true} を 1 行出す。
import { createInterface } from "node:readline";
import { createMessengerClient } from "@unagents/messenger-client";

const [url, name] = process.argv.slice(2);
const client = createMessengerClient({
  env: { AGENT_MESSENGER_DISCOVERY: "off" },
  name,
  brokers: [url],
  autoStartBroker: false,
  log: () => {},
});
client.onMessage((m) => {
  console.log(JSON.stringify({ from_name: m.from_name, text: m.text, meta: m.meta ?? null }));
});
await client.connect();
console.log(JSON.stringify({ ready: true }));
const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const { to, text, meta } = JSON.parse(line);
  void client.send(to, text, "push", meta ?? undefined).catch((e) => console.error(String(e)));
});
rl.on("close", async () => {
  await client.close().catch(() => {});
  process.exit(0);
});
