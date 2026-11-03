import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startBroker } from "@unagents/messenger-broker";
import { createMessengerClient } from "@unagents/messenger-client";
import { MESSENGER_PROTOCOL } from "@agent-hand/bantou-protocol";

const protocolDir = fileURLToPath(new URL("../../../../../packages/protocol/messenger", import.meta.url));

test("setProtocol で登録でき、listPeers(protocol) で発見され、meta 付きで届く", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bantou-protocol-test-"));
  const broker = await startBroker({
    port: 0,
    bind: "127.0.0.1",
    token: "",
    discovery: false,
    stateFile: join(dir, "broker.json"),
  });
  const mk = (name: string) =>
    createMessengerClient({
      env: { AGENT_MESSENGER_DISCOVERY: "off" },
      name,
      brokers: [`http://127.0.0.1:${broker.port}`],
      autoStartBroker: false,
    });
  const server = mk("bantou-server");
  const center = mk("bantou-center");
  try {
    await server.connect();
    await center.connect();
    const info = await server.setProtocol(protocolDir);
    assert.equal(info.name, MESSENGER_PROTOCOL.protocol);
    assert.equal(info.version, MESSENGER_PROTOCOL.version);

    const found = await center.listPeers("all", { protocol: "bantou" });
    assert.deepEqual(found.map((p) => p.name), ["bantou-server"]);
    assert.equal(found[0].protocols?.[0]?.version, MESSENGER_PROTOCOL.version);

    const got = new Promise<{ text: string; meta?: { protocol: string; version: string } | null }>((resolve) => {
      server.onMessage((m) => resolve(m));
    });
    await center.send(found[0].id, "hi", "pull", { protocol: "bantou", version: MESSENGER_PROTOCOL.version });
    const m = await Promise.race([got, new Promise<never>((_, rej) => setTimeout(() => rej(new Error("timeout")), 10_000))]);
    assert.deepEqual(m.meta, { protocol: "bantou", version: MESSENGER_PROTOCOL.version });

    await server.unsetProtocol();
    assert.deepEqual(await center.listPeers("all", { protocol: "bantou" }), []);
  } finally {
    await center.close().catch(() => {});
    await server.close().catch(() => {});
    await broker.close().catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
});
