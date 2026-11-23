# bantou message protocol (MVP)

Work sessions talk to bantou through agent-messenger. bantou is registered
on the broker as a plain HTTP peer named `bantou-core`. The broker is found
with agent-messenger's own discovery order; bantou has no connection setting. Send with the messenger `send_message`
tool, `to = "bantou-core"`, and put **one JSON object** in the text.

This document covers two message families: work session ↔ `bantou-core`
(`task` / `ask` / `ping`), and agent ↔ center (MCP tools,
see "center tools").

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

## Messenger protocol `bantou`

The protocol definition is `packages/protocol/messenger/protocol.json`
and `PROTOCOL.md`. It is the agent-messenger protocol version (`2.0.0`).
Changing the definition needs a new protocol
`version` (same name and version with other content is `PROTOCOL_CONFLICT`).

**Version rule.** The registered definition is `messenger/protocol.json` (compared after parsing, so whitespace does not count) plus `messenger/PROTOCOL.md` (every byte counts). The hash is `sha256(canonicalJSON({manifest, doc}))`, the same as the broker computes. Any change to either file, even an optional field or a wording fix, changes the hash: raise `version` in `protocol.json` and `MESSENGER_PROTOCOL.version` (`src/server.ts`) and add one `"<version>": "<hash>"` line to `messenger/versions.json`. `packages/protocol/test/versions.test.mjs` fails when the current definition does not match the hash recorded for the current version. A change that touches neither file (types, guards, this document) needs no new version. Why: on 2026-11-11 two servers registered `bantou@1.8.0` with different hashes and the broker refused the later one (`PROTOCOL_CONFLICT`), which then dropped out of discovery.

- Registration: on start the server calls `setProtocol(<dir>)` with the
  `protocol/` directory shipped in the npm package, and `unsetProtocol` on exit.
  If the registration fails, the server logs it and keeps serving by name.
- Discovery: `list_peers` with `protocol: "bantou"` returns the server. Peer
  ids change on re-registration, so resolve before each send.
- `meta`: send with `meta: {protocol: "bantou", version}` (version = the
  version the discovered peer declares). The server replies to the sender with
  the same meta. The server processes messages whose `meta.protocol` is
  `bantou`.
- If the versions differ, agent-messenger prefixes the text with a line
  `[agent-messenger warning] ...`; the center strips such lines before parsing.

## center tools

The center is an MCP server (stdio transport). An
agent calls its tools to run `claude remote-control` per project and to operate
caps and workers on servers. Config: `~/.config/bantou/center.json`.
Tool outputs are JSON text. A failure sets `isError`.

| tool | input | output |
|---|---|---|
| `rc_list` | none | list of remote-control records |
| `rc_start` | `project`, `resume?` (`true`: `--continue`, plain start when it cannot resume) | remote-control record |
| `rc_stop` | `project` | remote-control record |
| `rc_status` | `project` | remote-control record |
| `server_list` | none | `[{ name, connected, reachable, peerId, serverPeer }]` |
| `remote_send` | `server`, `model?`, `prompt` | `{ remote_id, server, model, sent: true }` |
| `remote_create` | same | alias of `remote_send` (same handling) |
| `worker_reply` | `server`, `session_id`, `order`, `content?` | `{ server, session_id, order, sent: true }` (also on `/mcp` for the desktop) |
| `remote_stop` | `server` | `{ remote_id, server, sent: true, forgotten }` |
| `remote_list` | `include_out_of_scope?` (`owner?` on `/mcp`) | `RemoteView[]`: `remote_id`, `session`, `server`, `serverName`, `server_label`, `state`, `finishedAt?`, `model`, `createdAt`, `owners` |
| `remote_wait` | `remote_id?` (`<parent-id>@<server>`), `server?`, `timeout_sec?` | the `RemoteView` |

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
| `auth` | the claude's auth state read from the pty (wrapper sessions): `ok`, `login_required` (`Please run /login` shown), `keychain_locked` (`/login` could not be saved). Back to `ok` at each start |
| `loginUrl` | the `/login` URL while a login is in progress, else null |
| `loginError` | why the last `/login` failed (`Invalid code`, `Couldn't save your login`), else null |

Session login (`session_login` `{ name }` → `{ name, loginUrl }`, `session_login_code` `{ name, code }` → `{ name, ok, auth, error }`)
types `/login` into the session's pty and waits for the URL, then for the result; see `packages/center/README.md`.
The center's `GET /events` reports `{"reason":"changed","name"}` when `auth` / `loginUrl` / `loginError` change.

