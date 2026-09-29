# bantou message protocol (MVP)

Work sessions talk to bantou through agent-messenger. bantou is registered
on the broker as a plain HTTP peer named `bantou-core`. The broker is found
with agent-messenger's own discovery order; bantou has no connection setting. Send with the messenger `send_message`
tool, `to = "bantou-core"`, and put **one JSON object** in the text.

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
