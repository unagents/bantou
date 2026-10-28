# bantou message protocol (MVP)

Work sessions talk to bantou through agent-messenger. bantou is registered
on the broker as a plain HTTP peer named `bantou-core`. The broker is found
with agent-messenger's own discovery order; bantou has no connection setting. Send with the messenger `send_message`
tool, `to = "bantou-core"`, and put **one JSON object** in the text.

This document covers three message families: work session ↔ `bantou-core`
(`task` / `ask` / `ping`), center or any peer ↔ `bantou-server` (commands and
replies, see "bantou-server commands"), and agent ↔ `bantou-center` (MCP tools,
see "bantou-center tools").

## Common fields

| key | required | meaning |
|---|---|---|
| `bantou` | yes | protocol version, always `1` |
| `type` | yes | `ask` or `task` |
| `task_id` | yes | stable task id = frontmatter `id` of the task md. `[A-Za-z0-9_-]` only |
| `session` | no | session name (= tag). Defaults to the sender's messenger name |

## `task` — create / update a task

```json
{"bantou":1,"type":"task","task_id":"t-cr001","title":"xlsx 取込の列マッピング","status":"Doing"}
```

- Unknown `task_id`: a Cork-format md is created (`<title>.md`, frontmatter
  `id` / `status` / `order` / `tags: [session]` / `date`).
- `body` (what the work is: goal, concrete work, done condition) becomes the
  md body; sending it again replaces the body.
- Known `task_id`: `status` (and `body` if given) is updated. The title (= file name) is
  never changed by messages.

## `ask` — wait for the user's reply

```json
{
  "bantou": 1,
  "type": "ask",
  "task_id": "t-cr001",
  "title": "xlsx 取込の列マッピング",
  "question": "期間列の形式が混在している。どう扱うか。",
  "options": [
    {"label": "両形式をパースする", "description": "取込漏れなし"},
    {"label": "パース失敗行はスキップ", "description": "後で手直し"}
  ]
}
```

- The task shows a waiting icon. `options` may be empty (free answer only).
- The user can always answer with free text instead of an option.

## `ping` — work is running

While it works on a task registered to bantou, the session runs `/loop` with a
5 minute interval (`/loop 5m ...`) and calls the messenger `send_ping` tool,
`to = "bantou-core"`, every 5 minutes. The ping carries the `task_id` (or the
title) of the task being worked on. The session stops the loop when the task is
done.

- bantou finds the task by id, then by exact title, and sets a 5 minute timer
  for it. Each new ping resets the timer to 5 minutes.
- On the board, a working task with a live timer shows a spinning icon. The
  icon stops when the timer runs out.
- A ping without a task id / title, or naming no known task, is ignored.
- Timers are kept in memory only; they are gone after bantou restarts.
- The ping payload is read from the message `text`, then from `subject`
  (messenger has not fixed the field name yet; `ping_subject` in `broker.rs`).

## Reply from bantou

When the user decides, bantou sends plain text back to the asking peer
(`from_name` of the `ask`):

```
【ユーザー回答（原文）】
<the user's answer as typed / the chosen option label>

【bantou 指示】
<instruction written by the bantou responder>
```

## Non-JSON messages

Anything that is not a `bantou: 1` envelope is appended to
`~/.local/share/bantou/<workspace-key>/inbox.jsonl` and not shown on the board (MVP).
Pings (`mode: "ping"`) are never stored there.

## Storage

| path | content |
|---|---|
| `<workspace>/*.md` | Cork-format tasks (+ frontmatter `id`) |
| `<workspace>/.cork.json` | Cork status list (read only) |
| `~/.local/share/bantou/<workspace-key>/sessions.json` | registered sessions (roster) |
| `~/.local/share/bantou/<workspace-key>/threads/<task_id>.json` | waiting thread + timeline + responder session id |
| `~/.local/share/bantou/<workspace-key>/inbox.jsonl` | non-envelope messages |

`<workspace-key>` is the workspace path with `/` replaced by `-`. bantou writes
nothing into the workspace except Cork task md files.

## bantou-server commands

`bantou-server` is a headless execution layer. It runs its own broker and is
registered as the messenger peer `bantou-server`. Send a command with the
messenger `send_message` tool, `to = "bantou-server"`, and put **one JSON
object** in the text. The sender is `bantou-center` or any other messenger peer.
The reply is sent back to the sender peer as one JSON object.

### Common fields

| key | required | meaning |
|---|---|---|
| `bantou` | yes | protocol version, always `1` |
| `type` | yes | `kick_cap`, `resume_worker`, `spawn_worker`, `worker_report` or `status` |

### `kick_cap` — start or resume a cap

```json
{"bantou":1,"type":"kick_cap","cap_id":"cap-a","repo":"https://github.com/o/r.git","branch":"main","prompt":"Review the open issues.","reason":"manual kick"}
```

| key | required | meaning |
|---|---|---|
| `cap_id` | yes | cap id, `[A-Za-z0-9_-]+`. Path is `<workspace>/caps/<cap_id>` |
| `prompt` | yes | non-empty instruction passed to claude |
| `repo` | no | git URL. Cloned on first use, fetched afterwards |
| `branch` | no | branch for `git clone --branch` |
| `reason` | no | free text, logged only, not passed to claude |

Reply: `cap_result` or `error`.

### `resume_worker` — start or resume a worker

```json
{"bantou":1,"type":"resume_worker","worker_id":"w-1","repo":"https://github.com/o/r.git","branch":"main","prompt":"Continue the task."}
```

| key | required | meaning |
|---|---|---|
| `worker_id` | yes | worker id, `[A-Za-z0-9_-]+`. Path is `<workspace>/workers/<worker_id>` |
| `prompt` | yes | non-empty instruction passed to claude |
| `repo` | no | same as `kick_cap` |
| `branch` | no | same as `kick_cap` |

Reply: `worker_result` or `error`.

### `spawn_worker` — cap starts a worker

Sent by a cap (through its injected messenger MCP, see below) to start a worker
and to record which cap owns it.

```json
{"bantou":1,"type":"spawn_worker","worker_id":"w-1","cap_id":"cap-a","prompt":"Run `echo hi` and report done."}
```

| key | required | meaning |
|---|---|---|
| `worker_id` | yes | worker id, `[A-Za-z0-9_-]+`. Path is `<workspace>/workers/<worker_id>` |
| `cap_id` | yes | owning cap id. This cap is resumed with the worker's reports |
| `prompt` | yes | non-empty instruction passed to the worker |
| `repo` | no | same as `kick_cap` |
| `branch` | no | same as `kick_cap` |

- The server writes `workers/<worker_id>/owner.json` (`{"cap_id":"..."}`) and starts the worker (new session, or resume if it already has one).
- **No reply is sent**, not even on success: the sending cap is a headless run that has usually ended. If the worker cannot start or its run fails (`ok: false`), the server resumes the owning cap with a prompt that describes the failure.

### `worker_report` — worker reports to its cap

Sent by a worker (through its injected messenger MCP).

```json
{"bantou":1,"type":"worker_report","worker_id":"w-1","kind":"done","text":"hi"}
```

| key | required | meaning |
|---|---|---|
| `worker_id` | yes | the worker's own id |
| `kind` | yes | `done` (finished) or `ask` (needs a decision) |
| `text` | yes | non-empty report text |

- The server reads `workers/<worker_id>/owner.json` and resumes that cap (`--resume`) with the report in its prompt. If the cap is running, the resume waits in the cap's queue.
- When that resumed run ends, the server sends a `cap_result` to the peer that last sent `kick_cap` for this cap (kept in `caps/<cap_id>/reply_to.json`).
- The cap gives a decision back to the worker with the existing `resume_worker`.
- Reply: none on success. `error` (with `command: "worker_report"` and `worker_id`) when `owner.json` is missing or broken, i.e. the worker was not started by `spawn_worker`.

Flow:

```
external --kick_cap--> server --claude -p--> cap
cap --spawn_worker (send_message)--> server --claude -p--> worker
worker --worker_report (send_message)--> server --claude -p --resume--> cap
server --cap_result--> external   (once per cap run, to the last kick_cap sender)
```

### `status` — list caps and workers

```json
{"bantou":1,"type":"status"}
```

No other fields. Reply: `status_result` or `error`. Answered immediately, even
while agents are running.

### Replies

Every reply carries `bantou: 1`.

`cap_result` / `worker_result` — one headless run finished (success or failure):

```json
{"bantou":1,"type":"cap_result","cap_id":"cap-a","session_id":"0b6f...-uuid","ok":true,"result_text":"kicked"}
{"bantou":1,"type":"worker_result","worker_id":"w-1","session_id":"9c1d...-uuid","ok":false,"result_text":"","error":"タイムアウト (1800000ms)"}
```

| key | meaning |
|---|---|
| `cap_id` / `worker_id` | id from the command (`cap_result` has `cap_id`, `worker_result` has `worker_id`) |
| `session_id` | claude session id used (new or resumed) |
| `ok` | `true` if the run succeeded |
| `result_text` | final `result` text of the run. `""` when it failed before producing one |
| `error` | failure detail when `ok` is `false` |

Sent only after the run ends, which can take minutes. A failed run is still a
`cap_result` / `worker_result` with `ok: false`.

A `cap_result` is also sent when a cap run started by the server itself (resume after
`worker_report` or after a worker failure) ends. It goes to the last `kick_cap` sender of that cap.
`worker_result` is only sent for `resume_worker`; a worker started by `spawn_worker` produces none.

`status_result`:

```json
{"bantou":1,"type":"status_result","ok":true,"caps":[{"kind":"cap","id":"cap-a","path":"/ws/caps/cap-a","session_id":"0b6f...-uuid","state":"idle","last_started_at":"2026-10-28T05:00:00.000Z","last_finished_at":"2026-10-28T05:01:10.000Z","retries":0,"queued":0}],"workers":[]}
```

| key | meaning |
|---|---|
| `ok` | always `true` |
| `caps` / `workers` | arrays of `AgentStatus` |

`AgentStatus`:

| key | meaning |
|---|---|
| `kind` | `cap` or `worker` |
| `id` | cap / worker id |
| `path` | absolute directory of the agent |
| `session_id` | claude session id, or `null` |
| `state` | `AgentState`, see below |
| `last_started_at` | ISO 8601, or `null` |
| `last_finished_at` | ISO 8601, or `null` |
| `last_error` | failure reason. Absent on success |
| `retries` | retries used by the latest run |
| `queued` | commands waiting in this agent's queue (the running one excluded) |

`AgentState`:

| state | meaning |
|---|---|
| `idle` | waiting |
| `running` | a run is in progress |
| `failed` | the latest run failed |
| `error` | could not be judged (e.g. orphan reaping failed, broken `state.json`). The agent is not started |

`error` — the command failed before a run started:

```json
{"bantou":1,"type":"error","ok":false,"message":"git clone 失敗: ...","command":"kick_cap"}
```

| key | meaning |
|---|---|
| `ok` | always `false` |
| `message` | failure reason |
| `command` | `type` of the failed command, when known |
| `cap_id` | `cap_id` of the failed `kick_cap`, when known |
| `worker_id` | `worker_id` of the failed `resume_worker` / `worker_report`, when known |

Typical causes: git failure, agent state `running` / `error`, broken `state.json`.

### Rules

- `cap_id` / `worker_id` match `[A-Za-z0-9_-]+`. A command with an invalid id is not answered with `error`; it is ignored as a non-command.
- `repo` / `branch` must not start with `-` and must not contain NUL.
- Commands to the same agent are serialized. Different agents run concurrently.
- First run of an agent uses `claude -p --session-id <uuid>`. Later runs use `--resume <uuid>`.
- If `--resume` fails with "No conversation found", the run is switched once to a new session id. This does not count as a retry.
- Timeout and spawn failure are retried up to the configured count (default 1). A retry of a new session uses a new session id. Other failures are not retried and end as `failed`.
- An agent in state `error` is not started and gets an `error` reply until the state is cleared by hand (delete or fix `state.json`).
- Text that is not a command (non-JSON, other JSON, pings) is ignored.
- The CLI `send` has `from_id` `cli`, which is not a peer. It cannot receive replies.

## bantou-server storage

| path | content |
|---|---|
| `<workspace>/caps/<cap_id>/` | cap path = cwd of claude |
| `<workspace>/workers/<worker_id>/` | worker path, same layout as a cap |
| `<path>/state.json` | agent state (shape below) |
| `<workspace>/workers/<worker_id>/owner.json` | `{"cap_id":"..."}`, written by `spawn_worker` |
| `<workspace>/caps/<cap_id>/reply_to.json` | `{"id":"<peer id>","name":"<peer name>"}`, the last `kick_cap` sender. Destination of `cap_result` after server-started resumes |
| `<path>/logs/<session_id>.jsonl` | raw claude output (stream-json), appended per run with a `# <ISO> mode=<mode> session=<id>` header line |
| `<workspace>/broker.json` | state file of the built-in broker |

With `repo`, the path is a git repo: cloned if absent, fetched if `.git`
exists, an error if the path exists without `.git`. After a clone,
`state.json`, `logs/`, `owner.json` and `reply_to.json` are added to `.git/info/exclude`. Without `repo`, the
path is only created.

`state.json`:

```json
{"session_id":"0b6f...-uuid","state":"idle","last_started_at":"2026-10-28T05:00:00.000Z","last_finished_at":"2026-10-28T05:01:10.000Z","retries":0}
```

| key | meaning |
|---|---|
| `session_id` | claude session id |
| `state` | `AgentState` |
| `last_started_at` / `last_finished_at` | ISO 8601 |
| `last_error` | failure reason. Absent on success |
| `retries` | retries used by the latest run |

## Messenger MCP injected into caps and workers

For every `claude -p` it starts, bantou-server adds:

- `--mcp-config <json>` with one stdio server `bantou-messenger` (default `npx -y @unagents/messenger@0.9.0 mcp`). Its env points at the built-in broker (`AGENT_MESSENGER_HOST` / `PORT` / `TOKEN`, `DISCOVERY=off`, `NAME=bantou-<cap|worker>-<id>`, `BROKER_CMD=false`, empty `CLAUDE_CODE_MESSAGING_*`, writable `npm_config_cache` and `AGENT_MESSENGER_PKGS_DIR` under the workspace).
- `--strict-mcp-config` (no other MCP server is loaded) and `--allowedTools mcp__bantou-messenger__send_message`.
- `--append-system-prompt` on new sessions only: the agent's own kind and id, the target `bantou-server`, the types it may send with a one-line JSON example each, and "send with send_message, do not wait for a reply". Fixed per id.
- A child env without inherited `AGENT_MESSENGER_*` and `CLAUDE_CODE_MESSAGING_*`.

A cap sends `spawn_worker` / `resume_worker`; a worker sends `worker_report`; all with `send_message`, `to = "bantou-server"`.

## bantou-center tools

`bantou-center` is an MCP server (name `bantou-center`, stdio transport). An
agent calls its tools to run `claude remote-control` per project and to operate
caps and workers on bantou-servers. Config: `~/.config/bantou/center.json`.
Tool outputs are JSON text. A failure sets `isError`.

| tool | input | output |
|---|---|---|
| `rc_list` | none | list of remote-control records |
| `rc_start` | `project` | remote-control record |
| `rc_stop` | `project` | remote-control record |
| `rc_status` | `project` | remote-control record |
| `server_list` | none | `[{ name, broker, connected, reachable, peerId }]` |
| `cap_kick` | `server`, `cap_id`, `prompt`, `repo?`, `branch?`, `reason?` | `cap_result` or `error` reply, verbatim JSON |
| `worker_resume` | `server`, `worker_id`, `prompt`, `repo?`, `branch?` | `worker_result` or `error` reply, verbatim JSON |
| `server_status` | `server` | `status_result` or `error` reply, verbatim JSON |

Remote-control record:

| key | meaning |
|---|---|
| `project` | project name |
| `path` | project directory |
| `state` | `stopped`, `starting`, `connected` or `error` |
| `pid` | process id of `claude remote-control` |
| `sessionUrl` / `environmentUrl` | URLs reported by remote-control |
| `restarts` | restart count |
| `lastExit` | last exit information |
| `lastError` | last error. Optional |
| `startedAt` | start time |
| `args` | arguments of the process |

`server` is a server name from `center.json`. `cap_kick`, `worker_resume` and
`server_status` fields match the `kick_cap`, `resume_worker` and `status`
commands.

### Reply correlation and timeout

The center connects to each configured bantou-server broker as the messenger
peer `bantou-center`. It sends the command and matches the reply by `cap_id`
(`cap_result`), by `worker_id` (`worker_result`), and in FIFO order for
`status_result`. An `error` reply is matched by its `cap_id` / `worker_id` when
present, otherwise to the oldest pending request with the same `command`. If no reply arrives within the configured timeout (default 35
minutes), the tool returns an `error` reply with message `タイムアウト (...)`.
