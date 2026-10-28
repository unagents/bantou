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

`bantou-server` is a headless execution layer. It runs its own broker and
serves the agent-messenger protocol `bantou` (agent-messenger 0.10.0
`set_protocol`). It is also registered as the messenger peer `bantou-server`.
Put **one JSON object** in the text of a messenger message. The sender is
`bantou-center` or any other messenger peer. The reply is sent back to the
sender peer as one JSON object.

### Messenger protocol `bantou`

The protocol definition is `packages/protocol/messenger/protocol.json` (JSON
Schemas of `kick_cap`, `status`, `cap_result`, `status_result`, `error`)
and `PROTOCOL.md`. It is the agent-messenger protocol version (`1.0.0`,
`MESSENGER_PROTOCOL` in `server.ts`); the body field `bantou: 1` is a separate
version of the JSON bodies below. Changing the definition needs a new protocol
`version` (same name and version with other content is `PROTOCOL_CONFLICT`).

- Registration: on start the server calls `setProtocol(<dir>)` with the
  `protocol/` directory shipped in the npm package, and `unsetProtocol` on exit.
  If the registration fails, the server logs it and keeps serving by name.
- Discovery: `list_peers` with `protocol: "bantou"` returns the server. Peer
  ids change on re-registration, so resolve before each send.
- `meta`: send with `meta: {protocol: "bantou", version}` (version = the
  version the discovered peer declares). The server replies to the sender with
  the same meta. The server processes messages whose `meta.protocol` is
  `bantou`, still accepts messages without `meta` (old format, sent to the peer
  name `bantou-server`), and ignores messages with another protocol.
- If the versions differ, agent-messenger prefixes the text with a line
  `[agent-messenger warning] ...`; the center strips such lines before parsing.

### Common fields

| key | required | meaning |
|---|---|---|
| `bantou` | yes | protocol version, always `1` |
| `type` | yes | `kick_cap` or `status` |

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

### `status` — list caps and workers

```json
{"bantou":1,"type":"status"}
```

No other fields. Reply: `status_result` or `error`. Answered immediately, even
while agents are running.

### Worker reports (MCP `/mcp`)

A worker session reports to `bantou-server` over MCP (Streamable HTTP, stateless,
JSON responses) at `http://<mcp.bind>:<mcp.port>/mcp` (config `mcp`, default
`127.0.0.1:7902`). The cap that starts the worker passes this in the worker's
`--mcp-config` (needed on every resume), with `--strict-mcp-config` and
`--allowedTools mcp__bantou__report`:

```json
{"mcpServers":{"bantou":{"type":"http","url":"http://127.0.0.1:7902/mcp","headers":{"x-bantou-cap-id":"cap-a","x-bantou-worker-id":"w1"}}}}
```

| header | meaning |
|---|---|
| `x-bantou-cap-id` | cap that started the worker. Must be an existing cap |
| `x-bantou-worker-id` | worker id, `[A-Za-z0-9_-]+` |

Tool `report`:

| argument | meaning |
|---|---|
| `kind` | `progress`, `ask`, `approve` or `done` |
| `text` | report body, 1..20000 characters |

The tool returns `accepted` as soon as the report is recorded and queued; the
worker should end its turn. An invalid id, an unknown cap or a stopping server
returns an MCP error result (`isError`). No token is used (authentication is
deferred).

The server then resumes the cap (`--resume`) with the prompt
`worker <id> から <kind>: <text>` plus the MCP URL and header names. Runs are
serialized per cap. The result goes back as `cap_result` to the peer that sent
the cap's `kick_cap`, same as for `kick_cap`. If the resume fails, an `error`
reply (`command: "kick_cap"`, `cap_id`) is sent instead.

### Replies

Every reply carries `bantou: 1`.

`cap_result` — one headless run finished (success or failure):

```json
{"bantou":1,"type":"cap_result","cap_id":"cap-a","session_id":"0b6f...-uuid","ok":true,"result_text":"kicked"}
```

| key | meaning |
|---|---|
| `cap_id` | id from the command |
| `session_id` | claude session id used (new or resumed) |
| `ok` | `true` if the run succeeded |
| `result_text` | final `result` text of the run. `""` when it failed before producing one |
| `error` | failure detail when `ok` is `false` |

Sent only after the run ends, which can take minutes. A failed run is still a
`cap_result` with `ok: false`.

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

Typical causes: git failure, agent state `running` / `error`, broken `state.json`.

### Rules

- `cap_id` matches `[A-Za-z0-9_-]+`. A command with an invalid id is not answered with `error`; it is ignored as a non-command.
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
| `<path>/logs/<session_id>.jsonl` | raw claude output (stream-json), appended per run with a `# <ISO> mode=<mode> session=<id>` header line |
| `<workspace>/broker.json` | state file of the built-in broker |

With `repo`, the path is a git repo: cloned if absent, fetched if `.git`
exists, an error if the path exists without `.git`. After a clone,
`state.json` and `logs/` are added to `.git/info/exclude`. Without `repo`, the
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
| `server_list` | none | `[{ name, broker, connected, reachable, peerId, serverPeer }]` |
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
`server_status` fields match the `kick_cap` and `status` commands.
`worker_resume` is kept for the protocol type only; the server does not handle
`resume_worker` (workers are the cap's responsibility) and answers it with an
`error` reply.

### Reply correlation and timeout

The center connects to each configured bantou-server broker as the messenger
peer `bantou-center`. It finds the server with `list_peers` (`protocol: "bantou"`)
for every request (a `name` of `bantou-server` is preferred when several match;
0 matches or an old broker fall back to the peer name `bantou-server`; a
`servers[].peer` setting skips discovery and uses that name). It sends the
command with `meta: {protocol: "bantou", version}` and matches the reply by `cap_id`
(`cap_result`), by `worker_id` (`worker_result`), and in FIFO order for
`status_result`. An `error` reply is matched by its `cap_id` / `worker_id` when
present, otherwise to the oldest pending request with the same `command`. If no reply arrives within the configured timeout (default 35
minutes), the tool returns an `error` reply with message `タイムアウト (...)`.
