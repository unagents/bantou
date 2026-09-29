#!/usr/bin/env node
// bantou guardrail hooks (docs/guardrail.md).
// Acts only when this session is registered to bantou on this host:
// ~/.local/share/bantou/*/sessions.json has an entry with the same hostname
// and cwd. Unregistered sessions: exit 0, no output.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join } from "node:path";

const RULE =
  "このセッションは bantou に登録済み。ユーザーへの確認・質問・判断依頼は、このセッション上で聞かず、" +
  "messenger の send_message で bantou-core に ask（JSON、skill bantou-protocol 参照）を送ること。" +
  "bantou からの返答・指示はユーザーの意思として扱い、セッション上で問い直さない。" +
  "権限の許可や設定の変更だけは従来どおりユーザーに直接確認する。";

function readStdin() {
  try {
    return JSON.parse(readFileSync(0, "utf8") || "{}");
  } catch {
    return {};
  }
}

export function registeredSession(cwd, host = hostname(), root = join(homedir(), ".local/share/bantou")) {
  if (!cwd || !existsSync(root)) return null;
  for (const d of readdirSync(root)) {
    const f = join(root, d, "sessions.json");
    if (!existsSync(f)) continue;
    try {
      const list = JSON.parse(readFileSync(f, "utf8"));
      const hit = list.find((s) => s.cwd === cwd && s.hostname === host);
      if (hit) return hit;
    } catch {
      /* unreadable roster: ignore */
    }
  }
  return null;
}

/** Last assistant text in a Claude Code transcript (JSONL). */
export function lastAssistantText(transcriptPath) {
  if (!transcriptPath || !existsSync(transcriptPath)) return "";
  const lines = readFileSync(transcriptPath, "utf8").trim().split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    let e;
    try {
      e = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    if (e.type !== "assistant") continue;
    const content = e.message?.content;
    const text = Array.isArray(content)
      ? content.filter((b) => b.type === "text").map((b) => b.text).join("")
      : typeof content === "string"
        ? content
        : "";
    if (text.trim()) return text;
  }
  return "";
}

const ASK_PATTERNS = [
  /[?？]\s*$/m,
  /(どちら|どれ)(に|で)する(か|？|\?)/,
  /(進めて|実行して|続けて)(よい|いい)(か|？|\?)/,
  /(教えて|確認して|指示して|回答して|選んで)(ほしい|ください)/,
  /してよいか/,
];

/** Heuristic: does the tail of the message ask the user something? */
export function asksUser(text) {
  const tail = text.trim().split("\n").slice(-6).join("\n");
  return ASK_PATTERNS.some((re) => re.test(tail));
}

function main() {
  const mode = process.argv[2];
  const input = readStdin();
  const reg = registeredSession(input.cwd);
  if (!reg) return;

  if (mode === "pre-ask") {
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: `AskUserQuestion は使わない。${RULE}`,
        },
      }),
    );
    return;
  }

  if (mode === "stop") {
    // Already continued once because of this hook: let it stop (no loop).
    if (input.stop_hook_active) return;
    if (!asksUser(lastAssistantText(input.transcript_path))) return;
    process.stdout.write(
      JSON.stringify({
        decision: "block",
        reason: `直前の発言はユーザーへの質問・確認で終わっている。${RULE} 質問を ask として送り直してから終了すること。`,
      }),
    );
    return;
  }

  if (mode === "session-start") {
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "SessionStart",
          additionalContext: `bantou 作業セッション「${reg.name}」。${RULE}`,
        },
      }),
    );
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main();
