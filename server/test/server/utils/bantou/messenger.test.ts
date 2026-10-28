import { test } from "node:test";
import assert from "node:assert/strict";
import { parseServerCommand } from "@agent-hand/bantou-protocol";
import { DEFAULT_MESSENGER } from "../../../../server/utils/bantou/config";
import { matchesSession } from "../../../../server/utils/bantou/processes";
import {
  buildInjectArgs,
  buildMcpConfig,
  buildSystemPrompt,
  childEnv,
  MCP_SERVER_NAME,
  SEND_MESSAGE_TOOL,
} from "../../../../server/utils/bantou/messenger";

const broker = { host: "127.0.0.1", port: 4321, token: "tok" };

test("messenger: MCP config（server 名・command・env）", () => {
  const j = JSON.parse(buildMcpConfig("cap", "c1", broker, DEFAULT_MESSENGER, "/ws"));
  assert.deepEqual(Object.keys(j.mcpServers), [MCP_SERVER_NAME]);
  const s = j.mcpServers[MCP_SERVER_NAME];
  assert.equal(s.type, "stdio");
  assert.equal(s.command, "npx");
  assert.deepEqual(s.args, ["-y", "@unagents/messenger@0.9.0", "mcp"]);
  assert.equal(s.env.AGENT_MESSENGER_HOST, "127.0.0.1");
  assert.equal(s.env.AGENT_MESSENGER_PORT, "4321");
  assert.equal(s.env.AGENT_MESSENGER_DISCOVERY, "off");
  assert.equal(s.env.AGENT_MESSENGER_NAME, "bantou-cap-c1");
  assert.equal(s.env.AGENT_MESSENGER_TOKEN, "tok");
  assert.equal(s.env.AGENT_MESSENGER_BROKER_CMD, "false");
  assert.equal(s.env.CLAUDE_CODE_MESSAGING_SOCKET, "");
  assert.equal(s.env.CLAUDE_CODE_MESSAGING_TOKEN, "");
  assert.equal(s.env.npm_config_cache, "/ws/.npm-cache");
  assert.equal(s.env.AGENT_MESSENGER_PKGS_DIR, "/ws/.messenger-pkgs");
  assert.equal(s.env.AGENT_MESSENGER_CLIENT_SPEC, "0.9.0");
});

test("messenger: token 空なら env に入れない。command / args / env は差し替え可能", () => {
  const j = JSON.parse(
    buildMcpConfig(
      "worker",
      "w1",
      { ...broker, token: "" },
      { command: "node", args: ["m.js"], env: { npm_config_cache: "/x", EXTRA: "1" } },
      "/ws",
    ),
  );
  const s = j.mcpServers[MCP_SERVER_NAME];
  assert.equal("AGENT_MESSENGER_TOKEN" in s.env, false);
  assert.equal(s.command, "node");
  assert.deepEqual(s.args, ["m.js"]);
  assert.equal(s.env.npm_config_cache, "/x");
  assert.equal(s.env.EXTRA, "1");
  assert.equal(s.env.AGENT_MESSENGER_NAME, "bantou-worker-w1");
});

test("messenger: system prompt は id 固定・' -- ' を含まず、例の JSON が protocol として通る", () => {
  for (const [kind, id] of [["cap", "c-1"], ["worker", "w_1"]] as const) {
    const p = buildSystemPrompt(kind, id);
    assert.equal(p, buildSystemPrompt(kind, id));
    assert.ok(p.includes(id));
    assert.ok(p.includes("bantou-server"));
    assert.ok(p.includes("send_message"));
    assert.ok(p.includes("do not wait for a reply"));
    assert.equal(p.includes(" -- "), false);
    const examples = p.split("\n").filter((l) => /\{"bantou":1/.test(l));
    assert.ok(examples.length >= 2);
    for (const line of examples) {
      const json = line.slice(line.indexOf("{"));
      const filled = json.replace(/<[^>]*>/g, "x");
      const cmd = parseServerCommand(filled);
      assert.ok(cmd, `example must parse: ${filled}`);
    }
  }
  const cap = buildSystemPrompt("cap", "c1");
  assert.ok(cap.includes("spawn_worker") && cap.includes("resume_worker"));
  assert.ok(cap.includes('"cap_id":"c1"'));
  const worker = buildSystemPrompt("worker", "w1");
  assert.ok(worker.includes("worker_report") && worker.includes('"worker_id":"w1"'));
  assert.ok(worker.includes('"kind":"done"') && worker.includes('"kind":"ask"'));
});

test("messenger: injectArgs は new だけ append-system-prompt を付ける。matchesSession を壊さない", () => {
  const n = buildInjectArgs("cap", "c1", "new", broker, DEFAULT_MESSENGER, "/ws");
  assert.deepEqual(n.slice(0, 1), ["--mcp-config"]);
  assert.equal(n[2], "--strict-mcp-config");
  assert.equal(n[3], "--append-system-prompt");
  assert.equal(n[4], buildSystemPrompt("cap", "c1"));
  const r = buildInjectArgs("cap", "c1", "resume", broker, DEFAULT_MESSENGER, "/ws");
  assert.deepEqual(r, n.slice(0, 3));
  const argv = ["claude", "-p", "--session-id", "sid-9", ...n, "--", "prompt"].join(" ");
  assert.ok(matchesSession(argv, "sid-9"));
});

test("messenger: SEND_MESSAGE_TOOL", () => {
  assert.equal(SEND_MESSAGE_TOOL, "mcp__bantou-messenger__send_message");
});

test("messenger: childEnv は継承 AGENT_MESSENGER_* / CLAUDE_CODE_MESSAGING_* を除き session.env を重ねる", () => {
  const out = childEnv(
    {
      PATH: "/bin",
      AGENT_MESSENGER_HOST: "prod",
      AGENT_MESSENGER_TOKEN: "t",
      CLAUDE_CODE_MESSAGING_SOCKET: "/s",
      CLAUDE_CODE_MESSAGING_TOKEN: "t",
      CLAUDE_CONFIG_DIR: "/old",
    },
    { CLAUDE_CONFIG_DIR: "/new" },
  );
  assert.deepEqual(out, { PATH: "/bin", CLAUDE_CONFIG_DIR: "/new" });
});
