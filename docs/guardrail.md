# Guardrail: registered sessions must not ask the user directly

## Problem

A work session registered to bantou is told (registration notice + skill)
to send every confirmation / question to bantou as an `ask`. That is only an
instruction; the agent can still ask in its own terminal (plain text or
`AskUserQuestion`). It happened in practice: the bantou dev session asked in
the terminal right after being registered.

Instructions alone cannot guarantee the rule. The guardrail moves it into
Claude Code hooks, which the harness runs regardless of what the agent
decides.

## Implementation

`plugin/bantou/` (Claude Code plugin): `hooks/hooks.json` + `scripts/guard.mjs`
+ `skills/bantou-protocol/`. Scope: sessions on the host running bantou.

## Design

Distribute a `bantou` plugin (skill + hooks) through the agent-hand
marketplace, next to `messenger`. Hooks only act when the session is
registered to bantou; unregistered sessions are untouched.

| # | Hook | Trigger | Action |
|---|---|---|---|
| 1 | `PreToolUse` matcher `AskUserQuestion` | agent tries to show a choice prompt | `deny` with reason: "registered to bantou: send this as an ask (skill bantou-protocol)". The agent gets the reason and re-sends via messenger. |
| 2 | `Stop` | agent is about to end its turn | read the last assistant message from `transcript_path`; if it asks the user something (question to the user, request for a decision/confirmation), return `decision: block` with the same reason, so the agent continues and sends an `ask` instead of stopping on a question. |
| 3 | `SessionStart` | session starts / resumes | if registered, inject a short reminder of the rule as additional context (survives compaction and restarts). |

### "Registered" check

The hook compares this session with bantou's roster:
`~/.local/share/bantou/*/sessions.json` has an entry whose `hostname` and
`cwd` match the session. No file is written into the session's project.

Limit: the roster lives on the host running bantou. Sessions on other hosts
(202 / 204 / proA1989 ...) cannot read it. Options for them are an open
question (below).

### Detection in #2

Heuristic on the last assistant text (ends with a question to the user,
`？`/`?` in the final lines, phrases like 「どちらにするか」「進めてよいか」「教えてほしい」).
False positives only cost one extra turn (the agent re-checks and stops);
false negatives fall back to the skill instruction.

### Why not rely on the prompt only

The registration notice and skill stay, but they are advisory. #1 is a hard
block. #2 is a strong nudge that turns the most common slip (ending a turn
on a question) into an automatic correction.

## Open questions

1. Remote sessions: how the hook on another host learns it is registered
   (e.g. bantou answers a lookup over the broker, or the hook asks the
   broker for bantou's roster).
2. Distribution: add the `bantou` plugin to the agent-hand marketplace
   (Gitea `agent-hand/plugins`), installed per host.
