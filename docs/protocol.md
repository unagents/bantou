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

`bantou-server` is a headless execution layer. It runs its own broker (it does not depend on it: the
server itself connects to whichever broker the normal agent-messenger resolution
finds, such as the LAN's standing broker) and
serves the agent-messenger protocol `bantou` (agent-messenger 0.10.0
`set_protocol`). It is also registered as the messenger peer `bantou-server`.
Put **one JSON object** in the text of a messenger message. The sender is
`bantou-center` or any other messenger peer. The reply is sent back to the
sender peer as one JSON object.

### Messenger protocol `bantou`

The protocol definition is `packages/protocol/messenger/protocol.json` (JSON
Schemas of `kick_cap`, `stop_cap`, `status`, `hello`, `update_server`, `cap_result`, `stop_result`, `status_result`, `hello_result`, `update_result`, `error`, `activity`)
and `PROTOCOL.md`. It is the agent-messenger protocol version (`1.3.0`,
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
| `type` | yes | `kick_cap`, `stop_cap`, `status`, `hello` or `update_server` |

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

### `stop_cap` — stop a running cap

```json
{"bantou":1,"type":"stop_cap","cap_id":"cap-a"}
```

Kills the process group of the cap's running `claude -p` (SIGTERM, then
SIGKILL after a short grace). Reply: `stop_result` `{"bantou":1,"type":"stop_result","ok":true,"cap_id":"cap-a","stopped":true}`
(`stopped` is false when the cap is not running) or `error`. The interrupted
`kick_cap` gets its own `cap_result` with `ok:false`. Not stopped: queued
commands behind the running one, and workers the cap started outside its own
process group (see server README).

### `status` — list caps and workers

```json
{"bantou":1,"type":"status"}
```

No other fields. Reply: `status_result` or `error`. Answered immediately, even
while agents are running.

### `hello` — ask the server's version

```json
{"bantou":1,"type":"hello"}
```

No other fields. Reply: `hello_result`
`{"bantou":1,"type":"hello_result","ok":true,"server_version":"0.3.0","protocol_version":"1.3.0","update":null,"last_update":null}`.
`server_version` is the npm `bantou` version of the running server. `update` is
`{"state":"waiting"|"restarting","from","to","running":{"caps","workers","reports"}}` while an update is
in progress. `last_update` is `{"to","ok":false,"error","at"}` for the last update that failed (kept until the
next attempt). Servers older than protocol `1.3.0` do not know `hello` and do not answer, so a center
decides by the protocol version the peer declares and sends nothing there.

### `update_server` — update the server to a version

```json
{"bantou":1,"type":"update_server","version":"0.3.1"}
```

`version` is semver (`^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$`). The server fetches `bantou@<version>` with
`npx -y` (the package source is the server's config `update.spec`, never this message: there is no
authentication), then replies `update_result`
`{"bantou":1,"type":"update_result","ok":true,"state":"current"|"waiting"|"restarting","from","to","running":{...}}`
right away. It does **not** wait for the runs. `current` means it already runs that version. A failed fetch is
an `error` with `code:"update_failed"` (the server keeps serving normally).

While `waiting`, the server restarts itself only after every running cap and worker (and worker reports being
handled) are done. Meanwhile:

- `kick_cap` is refused with `error` `{"code":"updating","retryable":true,"command":"kick_cap","cap_id":...}`
  and a reason (`server 更新待ち（<from>→<to>）...再起動後に再送`). The center may send it again after the restart.
- `stop_cap`, `status` and `hello` are still served. Worker `report` and `worker_start` over MCP are
  still accepted (they belong to the caps that are running).
- `update_server` with the same version answers `waiting` again; another version is
  `error` `code:"update_conflict"`.

`hello` / `update_server` and their replies keep this shape for good, and a center sends them to servers of
any protocol version (1.3.0 and later): they are the only way to update a server whose protocol version differs
from the center's. All other commands are not sent to a server whose protocol version differs (the center
refuses with `error` `code:"version_mismatch"`, `retryable:true`).

`error` replies may carry `code` (`updating` | `update_failed` | `update_conflict` | `invalid_version` |
`version_mismatch`) and `retryable` (boolean).

### Worker reports (MCP `/mcp`)

A worker session reports to `bantou-server` over MCP (Streamable HTTP, stateless,
JSON responses) at `http://<mcp.bind>:<mcp.port>/mcp` (config `mcp`, default
`127.0.0.1:7902`). The server starts every worker (see "Starting workers") and
writes this into `<worker path>/logs/mcp.json`, passed as `--mcp-config` on
every run, with `--allowedTools mcp__bantou__report`:

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
`worker <id> から <kind>: <text>` plus a line saying that a reply to the worker
goes through `worker_start` with the same `worker_id`. Runs are
serialized per cap. The result goes back as `cap_result` to the peer that sent
the cap's `kick_cap`, same as for `kick_cap`. If the resume fails, an `error`
reply (`command: "kick_cap"`, `cap_id`) is sent instead.

### Starting workers (MCP `/mcp`)

A cap (a connection with header `x-bantou-cap-id` and no `x-bantou-worker-id`)
also gets three tools on the same `/mcp`; the server gives its `claude -p` the
matching `--mcp-config` and `--allowedTools`. A worker connection has only `report`.
Results are JSON text; a failure sets `isError` with `{"error":"..."}`.

| tool | input | result |
|---|---|---|
| `worker_start` | `prompt`, `worker_id?` (`[A-Za-z0-9_-]+`), `repo?`, `branch?` | `{"worker_id":"w-1f2e3d4c5b","accepted":true}` |
| `worker_status` | `worker_id?` | `{"workers":[AgentActivity,...]}` |
| `worker_stop` | `worker_id` | `{"worker_id":"w-...","stopped":true}` |

- `worker_start` returns without waiting for the work. Without `worker_id` the server
  makes `w-<10 hex>` and starts a new session; with an existing id it resumes
  that session (the next instruction). Output goes to the worker's
  `logs/<session>.jsonl`.
- A worker belongs to the cap that first started it (`logs/owner.json`). Another
  cap gets `別の cap の worker: <id>` from all three tools.
- `worker_status` returns `AgentActivity` (see "Activity notices") of that cap's workers.
- `worker_stop` sends SIGTERM to the worker's process group, SIGKILL after 3 s.

### Activity notices (server to center)

`activity` is a notice, not a reply: it is never matched with a pending command.
The server sends it to the peer that sent the cap's `kick_cap`, as a snapshot of
the cap and all its workers. Messages carry the same `meta` as replies.

```json
{"bantou":1,"type":"activity","cap_id":"r-0a1b2c3d4e","at":"2026-10-29T01:00:05.000Z","agents":[{"kind":"worker","id":"w-1f2e3d4c5b","cap_id":"r-0a1b2c3d4e","state":"running","task":"server に worker tool を追加する","last_activity":"Bash 実行中 60s","last_output_at":"2026-10-29T01:00:03.000Z","silent_ms":2000,"started_at":"2026-10-29T00:58:05.000Z","finished_at":null}]}
```

| key | meaning |
|---|---|
| `cap_id` | the cap the snapshot is about |
| `at` | send time, server clock (ISO 8601) |
| `agents` | `AgentActivity[]`: the cap first, then its workers by id |

`AgentActivity`:

| key | meaning |
|---|---|
| `kind` / `id` | `cap` or `worker`, and its id |
| `cap_id` | the cap itself, or the owning cap of a worker |
| `state` | see below |
| `task` | head of the last `kick_cap` / `worker_start` prompt (one line, at most 200 chars). A cap resumed by a worker report keeps its task |
| `last_activity` | summary of the latest activity (at most 120 chars), or `null` |
| `last_output_at` | when the last stdout line arrived (server clock), or `null` |
| `silent_ms` | ms since the last output (or `started_at`) at send time. Use this for elapsed time, not clock differences between hosts |
| `started_at` / `finished_at` | ISO 8601, or `null` |
| `error` | why the agent is `failed` / `lost` (at most 200 chars) |

`state` (separate from `AgentState` of `state.json`):

| state | meaning |
|---|---|
| `running` | a run is in progress and output keeps coming |
| `stalled` | running, but no output for 300 s. Display only; nothing is killed. New output returns it to `running` |
| `idle` | the latest run ended normally (always so for a cap) |
| `done` | a worker's run ended normally and it sent `report` with `kind: "done"` during that run |
| `failed` | the run did not end normally (non-zero exit, unreadable result, timeout, stop, server shutdown, setup failure) |
| `lost` | the process was ended by a signal the server did not send (killed from outside), or the server found it `running` at startup with no process |

Cadence: every 5 s while any agent of the cap is `running` / `stalled`, plus
immediately at each state change (start, stalled, finish, startup reaping). When
all agents are in an end state, one last notice is sent and sending stops. A
failed send is logged only. The state is kept in memory on both sides. A peer
that does not know `activity` ignores it.

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
| `<cap path>/logs/center.json` | center that sent the cap's `kick_cap` (`{"center_id":"..."}`) |
| `<worker path>/logs/owner.json` | cap that owns the worker (`{"cap_id":"..."}`) |
| `<path>/logs/mcp.json` / `logs/system-prompt.md` | `--mcp-config` / `--append-system-prompt-file` of the latest run, rewritten every run |
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
| `server_list` | none | `[{ name, connected, reachable, peerId, serverPeer }]` |
| `server_peers` | `refresh?` | `{ pair: { server, protocol }, peers: [{ key, id, name, hostname?, server_version?, protocol_version?, state, detail, update?, since }] }`. `pair` = the versions built into this center (npm `bantou` and protocol). `state`: `ok` / `updating` (`update.running` = caps / workers being waited for) / `mismatch` / `unsupported` / `failed` / `lost` / `unknown`. `refresh: true` checks now |
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
`resume_worker` (a cap starts and continues workers with `worker_start`) and answers it with an
`error` reply.

`remote_list` returns `RemoteRecord[]` (`remote_id`, `owner`, `server`, `serverName`,
`state`, `createdAt`, `finishedAt?`, `result?`, `error?`). A remote that has received
`activity` notices also has `activity`:

| key | meaning |
|---|---|
| `at` | `at` of the last notice (server clock) |
| `received_ms_ago` | ms since the center received that notice (center clock) |
| `stale` | an agent is `running` / `stalled` but no notice came for 30 s (the server or the path may be down). The center does not turn it into `lost` |
| `agents` | `AgentActivity[]`; `silent_ms` is the notice's value plus the time since receipt |

A remote without notices has no `activity` key. `cap_kick` caps have no record, so they do not appear.

### Reply correlation and timeout

The center connects as the messenger peer `bantou-center`, a plain agent-messenger
client: the broker is found by the normal resolution (env, config file, UDP
discovery, local fallback) and no broker URL is configured. It finds the server with `list_peers` (`protocol: "bantou"`)
for every request (a `name` of `bantou-server` is preferred when several match;
0 matches or an old broker fall back to the peer name `bantou-server`; a
`servers[].peer` setting skips discovery and uses that name). It sends the
command with `meta: {protocol: "bantou", version}` and matches the reply by `cap_id`
(`cap_result`), by `worker_id` (`worker_result`), and in FIFO order for
`status_result`. An `error` reply is matched by its `cap_id` / `worker_id` when
present, otherwise to the oldest pending request with the same `command`. If no reply arrives within the configured timeout (default 35
minutes), the tool returns an `error` reply with message `タイムアウト (...)`.
