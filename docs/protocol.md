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
Schemas of `kick_cap`, `stop_cap`, `status`, `hello`, `update_server`, `task`, `worker_reply`, `cap_result`, `stop_result`, `status_result`, `hello_result`, `update_result`, `task_result`, `worker_reply_result`, `error`, `activity`, `worker_report`)
and `PROTOCOL.md`. It is the agent-messenger protocol version (`1.6.0`,
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
| `type` | yes | `kick_cap`, `stop_cap`, `status`, `hello`, `update_server`, `task` or `worker_reply` |

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
| `model` | no | model of the cap's own `claude -p`, passed as-is to `--model` (`sonnet`, `opus`, `claude-sonnet-5-5`, `opus[1m]` ...). `^[A-Za-z0-9._\[\]][A-Za-z0-9._\[\]-]*$`; anything else is an `error`. Absent = no `--model` |
| `worker_model` | no | default `--model` of the workers this cap starts (used when `worker_start` has no `model`). Same format. The server remembers it as the cap's default |

`model` and `worker_model` were added in protocol `1.4.0`. A server older than that ignores them (unknown fields are ignored), but a center does not send commands to a server whose protocol version differs (see below), so the server is updated first. A resumed cap (including the resume caused by a worker report) and a resumed worker keep using the same model.

Reply: `cap_result` or `error`.

### `task` — give a cap a task (1.5.0)

Not the work-session `task` envelope above (that one is a message to a work session). This one is a command to `bantou-server`, told apart by `meta.protocol` and its fields. `kick_cap` (one free-text prompt) stays for compatibility.

```json
{"bantou":1,"type":"task","cap_id":"c-0a1b2c3d4e","task_id":"t-20261104-1","goal":"packages/protocol に task メッセージを足す","repo":"https://github.com/unagents/bantou.git","branch":"feature/protocol-task","deliverables":{"branch":"feature/protocol-task","report_path":"docs/history/20261104-0900-task/report.md","other":["PR の説明文"]},"verify":{"tests":["npm test (packages/protocol)"],"steps":["差分を読んで型とガードの対応を確認"]},"constraints":["develop / main へ push しない","version bump しない"],"workers":{"items":[{"id":"impl","role":"implement","scope":"packages/protocol と docs"},{"role":"review","scope":"impl の差分","depends_on":["impl"]}]},"worker_model":"sonnet"}
```

| key | required | meaning |
|---|---|---|
| `cap_id` | yes | cap id (`[A-Za-z0-9_-]+`). Same `cap_id` again = resume |
| `task_id` | yes | task id (`[A-Za-z0-9_-]+`). Echoed in `task_result` and `worker_report` |
| `goal` | yes | natural-language goal, non-empty |
| `repo` / `branch` | no | the base of the work (git URL, branch). Same handling as `kick_cap`; must not start with `-` |
| `deliverables` | yes | `{branch?, report_path?, other?: string[]}`: push-target branch, where the reports go, other deliverables. May be `{}` |
| `verify` | yes | `{tests?: string[], steps?: string[]}`: tests to run and check steps. May be `{}` |
| `constraints` | yes | `string[]`, one constraint per entry. May be `[]` |
| `workers` | yes | `{items?: TaskWorkerItem[]}`. No `items` = the default: at least 2 workers, one `implement` and one `review`. May be `{}` |
| `worker_model` | no | default `--model` of the workers (same as `kick_cap` `worker_model`, same format) |

`TaskWorkerItem`: `role` (required: `implement` | `review` | `docs` | `test` | `other`), `scope` (required, what the worker covers), `id` (optional name, `[A-Za-z0-9_-]+`), `model` (optional, `--model` of this worker), `depends_on` (optional `id[]`: items that must finish first).

The server builds the cap's first instruction from the fields (text: `docs/design/cap-orchestration.md`, source of truth: `prompts.ts`) and runs it like `kick_cap`. Reply: `task_result` when the run finishes, or `error` (`command: "task"`, `cap_id`, `task_id`). While the server waits to update, `task` is refused like `kick_cap` (`error` `code:"updating"`, `command:"task"`, `retryable:true`).

`task` and `worker_reply` exist from protocol 1.5.0. A server older than that does not know them, and a center does not send commands to a server whose protocol version differs (see below), so the server is updated first.

### `worker_reply` — answer a worker (1.5.0)

```json
{"bantou":1,"type":"worker_reply","cap_id":"c-0a1b2c3d4e","worker_id":"w-1f2e3d4c5b","text":"develop ではなく feature/protocol-task に push して"}
```

| key | required | meaning |
|---|---|---|
| `cap_id` | yes | the cap that owns the worker |
| `worker_id` | yes | the worker to answer |
| `text` | yes | non-empty. Becomes the worker's next prompt |

The server runs `worker_start` for the cap with the same `worker_id` and `text` as the prompt (the worker resumes its session). Reply: `worker_reply_result` `{"bantou":1,"type":"worker_reply_result","ok":true,"cap_id","worker_id","accepted":true}` right after the start is accepted (it does not wait for the work), or `error` (`command:"worker_reply"`, `cap_id`, `worker_id`; for example an unknown cap, or a worker of another cap). The worker's next report arrives as a `worker_report` notice. Accepted while the server waits to update.

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
{"bantou":1,"type":"status","cap_id":"c-0a1b2c3d4e"}
```

`cap_id` is optional (1.6.0, `AGENT_ID_PATTERN`). Reply: `status_result` or `error`, the same with or without it. Answered immediately, even
while agents are running. With `cap_id` the server also takes the sender as the center to notify for that cap (see "Who is notified" below);
a center sends it after a restart to take its caps' notices back. A server older than 1.6.0 ignores `cap_id`.

### `hello` — ask the server's version

```json
{"bantou":1,"type":"hello"}
```

No other fields. Reply: `hello_result`
`{"bantou":1,"type":"hello_result","ok":true,"server_version":"0.3.0","protocol_version":"1.6.0","update":null,"last_update":null}`.
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

- `kick_cap` and `task` are refused with `error` `{"code":"updating","retryable":true,"command":"kick_cap" or "task","cap_id":...}` (`task` also carries `task_id`)
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
| `worker_start` | `prompt`, `worker_id?` (`[A-Za-z0-9_-]+`), `repo?`, `branch?`, `model?` | `{"worker_id":"w-1f2e3d4c5b","accepted":true}` |
| `worker_status` | `worker_id?` | `{"workers":[AgentActivity,...]}` |
| `worker_stop` | `worker_id` | `{"worker_id":"w-...","stopped":true}` |

- `worker_start` returns without waiting for the work. Without `worker_id` the server
  makes `w-<10 hex>` and starts a new session; with an existing id it resumes
  that session (the next instruction). Output goes to the worker's
  `logs/<session>.jsonl`.
- A worker belongs to the cap that first started it (`logs/owner.json`). Another
  cap gets `別の cap の worker: <id>` from all three tools.
- `worker_status` returns `AgentActivity` (see "Activity notices") of that cap's workers.
- `model` (same format as `kick_cap`) is the worker's `--model`. Without it the cap's `worker_model` is used, and without that no `--model`. A resumed worker keeps using the same model.
- `worker_stop` sends SIGTERM to the worker's process group, SIGKILL after 3 s.

### Who is notified (1.6.0)

The server keeps one **center** per cap: the peer **name** of the sender (`bantou-center`, from `from_name`) and the peer id it last used. `activity`, `worker_report`, and the `cap_result` / `task_result` / `error` that follow a worker report (the resume of the cap) go to it. The name is resolved to the current peer id **at send time** (`listPeers`), because a center that restarts gets a new peer id: if the remembered id is still registered under that name it is used (so with several peers of the same name, the one that sent the last command wins); otherwise the peer of that name that registered last is used (and remembered). With no peer of that name, or when the lookup fails, the remembered id is tried as it is. A record from before 1.6.0 holds a peer id only and is used as it is until the next command.

The center is updated by every command that carries a `cap_id`: `kick_cap`, `task`, `worker_reply`, `stop_cap` and `status` with `cap_id`. A center that restarted therefore sends `status` with `cap_id` for each cap it remembers, and gets its notices back without sending a new instruction. `status` / `stop_cap` / `worker_reply` update the memory of the server, and the cap's record file only when the cap exists (they never create a cap).

### Activity notices (server to center)

`activity` is a notice, not a reply: it is never matched with a pending command.
The server sends it to the center of the cap (see "Who is notified"), as a snapshot of
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
| `model` | model given with `--model`, or `null` when none was given. Absent from servers older than `1.4.0` |

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

### `worker_report` notices (server to center, 1.5.0)

A notice, like `activity`: it is never matched with a pending command. Every time a worker calls its `report` tool, the server sends it to the center of the cap (see "Who is notified"), in parallel with the resume of the cap (it does not wait for the resume; a failed send is logged and the cap is resumed anyway).

```json
{"bantou":1,"type":"worker_report","cap_id":"c-0a1b2c3d4e","task_id":"t-20261104-1","worker_id":"w-1f2e3d4c5b","kind":"ask","text":"push 先の branch はどれか","at":"2026-11-04T00:00:00.000Z"}
```

| key | meaning |
|---|---|
| `cap_id` | the cap that owns the worker |
| `task_id` | `task_id` of the latest `task` of the cap. Absent when the cap has had only `kick_cap` |
| `worker_id` | the reporting worker |
| `kind` | `progress`, `ask`, `approve` or `done` |
| `text` | the report text as the worker sent it (1..20000 chars) |
| `at` | receive time (server clock, ISO 8601) |

The center answers an `ask` / `approve` with `worker_reply`. A peer that does not know `worker_report` ignores it.

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

`task_result` (1.5.0) — the answer to `task`:

```json
{"bantou":1,"type":"task_result","cap_id":"c-0a1b2c3d4e","task_id":"t-20261104-1","state":"done","summary":"task メッセージを追加し、review の指摘 1 件を直した","workers":[{"worker_id":"w-1f2e3d4c5b","role":"implement","state":"done","branch":"feature/protocol-task","commit":"abc1234","tests":"npm test: 28 pass","report_path":"docs/history/20261104-0900-task/report.md","result":"型とガードを追加した…"},{"worker_id":"w-2a3b4c5d6e","role":"review","state":"done","result":"指摘 1 件、解消済み"}],"review":{"verdict":"ok","items":[{"severity":"medium","text":"worker_reply の text 検証が無い","resolved":true}],"rounds":1},"remaining":[]}
```

| key | meaning |
|---|---|
| `cap_id` / `task_id` | ids from the command |
| `state` | `done` = the run ended normally, `failed` = it did not |
| `summary` | summary of the result |
| `workers` | `{worker_id, role, state, branch?, commit?, tests?, report_path?, result}[]`. `role` as in `TaskWorkerItem`; `state` is an activity state (`running` / `stalled` / `idle` / `done` / `failed` / `lost`); `tests` = the tests run and their outcome (free text); `result` = head of the worker's result (at most 500 chars) |
| `review` | `{verdict, items, rounds}`. `verdict` `ok` / `issues` / `unknown`; `items` = `{severity: high|medium|low, text, resolved: boolean}[]`; `rounds` = number of implement <-> review round trips (integer, 0 = none) |
| `remaining` | what is left undone or unresolved, `string[]` |
| `error` | failure detail when `state` is `failed` |

The cap answers the `task` instruction with this JSON as its final answer; the server takes it out of the answer (a ```json block, else the last `{...}` that has a string `summary`), fills `cap_id` / `task_id` and fixes broken items to defaults. When none can be read: `summary` = the raw answer, `workers` and `remaining` empty, `review.verdict` `unknown` (a failed run: `state:"failed"` + `error`). A cap is resumed by every worker report, so an answer that is not final (such as "workers started, waiting") also becomes a `task_result` with verdict `unknown`. Completion stays what the center already uses: the cap is idle and no worker of it is running or stalled. When a worker report resumes the cap and the cap answers with the JSON, `task_result` is sent to the center again (the one that sent the `task`); any other answer after a report is a `cap_result` as before.

`worker_reply_result`: see `worker_reply`.

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
| `model` | model given with `--model`, or `null` when none was given. Absent from servers older than `1.4.0` |

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
| `cap_id` | `cap_id` of the failed `kick_cap` / `task` / `worker_reply`, when known |
| `task_id` | `task_id` of the failed `task`, when known (1.5.0) |
| `worker_id` | `worker_id` of the failed `worker_reply`, when known (1.5.0) |

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
| `<cap path>/logs/center.json` | center of the cap (`{"center_id":"<last peer id>","center_name":"<peer name>"}`; `center_name` is absent in a record from before 1.6.0) |
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

**One remote-cap per bantou-server.** Whatever the work is, the center sends the next instruction to that
cap; it never creates a cap per task. The center's cap id is fixed per center (`c-<10 hex>`, kept in
`center-id` next to `center.json`, so it survives a restart; a cap taken over from the old format keeps its own cap id, so the cap id is decided **per server** from its record, and the center's id is only used for a server that has no record). In the session window (`/mcp/session`):

| tool | input | output |
|---|---|---|
| `remote_send` | `goal`, `repo?`, `branch?`, `deliverables?`, `verify?`, `constraints?`, `workers?`, `server?`, `worker_model?` | `{ remote_id, server, serverName, state: "running", created, task_id, worker_model? }` |
| `remote_create` | same | alias of `remote_send` (same handling) |
| `worker_reply` | `remote_id?`, `worker_id`, `text`, `server?` | `{ remote_id, server, worker_id, accepted: true }` (sends `worker_reply`; also on `/mcp` for the desktop) |
| `remote_delete` | `remote_id?`, `server?`, `force?` | `{ remote_id, deleted, stopped, warning? }` (`stop_cap` + drop the record) |

`remote_send` first asks the server for `status` (`created: true` = the cap was not there; the server creates it on the first `task`),
then sends `task` with the same `cap_id` (a resume when the cap exists). `task_id` is assigned by the center and returned. Only `goal`
is required; `deliverables` / `verify` / `constraints` / `workers` default to `{}` / `{}` / `[]` / `{}` (no `workers.items` = at least
two workers, implement + review). The server runs a cap's commands one at a time, so a busy cap makes the instruction wait.
A server whose protocol version differs, or one waiting to update, is not sent `task`: `remote_send` returns an error and keeps no record.

Models. `remote_send` no longer takes `model` (the `task` message has no field for the cap's own model); `servers[].model` stays for `cap_kick`.
`worker_model` is the default model of the workers (`items[].model` wins). It is sent with `task` when given. For a new cap it
defaults to the center's `servers[].workerModel`, **read again at every `remote_send`** like `sessionInstructions`; for an existing cap the
config default is not re-sent. Precedence for a worker: `worker_start` `model` > the worker's recorded model > the cap's `worker_model` > none.

`remote_list` returns one `RemoteView` per server cap: `RemoteRecord` (`remote_id` = cap id, `server`, `serverName`,
`serverHost?`, `state`, `model?`, `worker_model?`, `createdAt`, `finishedAt?`, latest `result?` / `result_at?` / `error?` / `error_at?`, latest `task_result?`, `pending`) plus `owners` (sessions with a pending instruction), `worker_reports` (the latest 20 `worker_report` notices in arrival order; `[]` when none) and `activity?`. `pending` is the
unfinished instructions (`{at, owner, prompt (first 200 chars), task_id?}`); an instruction is removed when it completes. **No history is kept**
(no list of past instructions or results, no per-instruction notice status): only the latest result / error and its time, the latest `task_result` and the latest `worker_reports`. `remote_wait`
(`remote_id?`, `server?`, `timeout_sec?` default 600, max 1800) waits until the cap is idle and none of its workers is
`running` / `stalled`, and returns its record, or returns it with the current `state` (`running` / `unknown`) on timeout.
When the cap becomes idle with no worker running, the center closes **all** pending instructions and sends one done notice
(messenger `push`) to each session that sent one, not one per `cap_result`.

Completion is decided only when all of these hold: no `task` / `kick_cap` reply is pending, and the latest `activity` shows the cap
`idle` and no worker `running` / `stalled`. A `cap_result` does **not** complete a remote by itself, because the
`activity` that follows it may still show a running worker (seen in practice: the first `cap_result` arrived 10 s after an
activity with cap=running / worker=running, and an activity with cap=idle / worker=running came 21 ms later). After a
`cap_result` the center waits for the next `activity` (which settles it), or for a grace of **15 s** (3 of the server's 5 s notice
intervals); if no `activity` comes by then it fetches the server's `status` and judges from that (cap `idle`, `queued` 0, no
worker `running`; the status has no cap-to-worker link, so workers are checked server-wide). While the cap or a worker is running
the center follows it by `status` every 15 s.

`state` is `running` / `done` / `failed` / `unknown`. `unknown` = the center cannot tell: the `task` / `kick_cap` never reached the
server (the send itself failed or timed out), or `status` cannot be fetched. It is not `failed` (that is a `cap_result` with
`ok: false` or an `error` reply from the server). The center retries `status` every 15 s and the state returns to `running` /
`done` when it succeeds (or when an `activity` arrives); nothing is notified while `unknown`.

**Center restart** (the desktop release replaces the app, so the center restarts). Unfinished records are **not** closed as
`failed`: a record is restored as it was (`running`, pending instructions kept), then the center fetches the server's `status` and
follows it as above (`unknown` if `status` fails). A `cap_result` that arrives after the restart updates the latest
`result`, and completes the remote (with the notice) the same way. This relies on the messenger peer name of the center and the
sessions being the same after the restart (notices go to the session's peer name; a late reply comes back to `bantou-center`). If it
changed, the notice is not delivered (logged in `center.log`), and use `remote_wait` / `remote_list`. A record is deleted only by `remote_delete`, never by a restart. At startup the center also sends `status` with `cap_id` for every record to its server, so the server notifies this center again (it retries while the server is not visible yet; a record that follows `status` anyway sends it as part of that).
Records of the old format (one cap per task: `remote_id` is not the center's cap id, `history` form, ...) are **taken over** as the cap of their server in the new form (the cap id is kept; `history`, `legacy` and a record-level `owner` are dropped, only the pending instructions are kept). When one server has several, the active record (`running` / `unknown` / with pending instructions) comes first, and among equals the newest one (the latest of `createdAt` / `finishedAt` / `result_at` / `error_at`) is kept (several active records: only the newest active one is kept). This is an intended adjustment of "keep the newest": newest-only would keep a newer finished record and send `stop_cap` to the still running cap. The same server = the same peer id, or the same name and host (a record without a host counts as the server of the one live peer with that name, only when there is exactly one; a record that cannot be confirmed — no peer lookup, or several peers with the same name — is neither grouped nor sent `stop_cap`, and stays as it is until a later `status` fills in its host). The others get `stop_cap` (it may not arrive) and their records are deleted, logging the result in `center.log` (one-time cleanup of the per-task caps).

A remote that has received `activity` notices also has `activity`:

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
(`cap_result`), by `cap_id` + `task_id` (`task_result`, `error` of a `task`), by `cap_id` + `worker_id` (`worker_reply_result`, `error` of a `worker_reply`), by `worker_id` (`worker_result`), and in FIFO order for
`status_result`. An `error` reply is matched by its `cap_id` / `worker_id` when
present, otherwise to the oldest pending request with the same `command`. If no reply arrives within the configured timeout (default 35
minutes), the tool returns an `error` reply with message `タイムアウト (...)`.
