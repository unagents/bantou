# bantou protocol

bantou-server is the listener of this protocol. A center (or any peer) sends a command to the server and the server replies to the sender. All messages are one JSON object in the message text. The schemas are in `protocol.json`.

## Discovery and meta

- Find servers with `list_peers` and `protocol: "bantou"`.
- Send every message with `meta: {protocol: "bantou", version: "<protocol version>"}`. The server replies with the same meta.
- `version` is the registered protocol version (this file's `protocol.json`), not the body field `bantou`. The body always carries `"bantou": 1`.

## Commands (peer to server)

- `kick_cap`: `{"bantou":1,"type":"kick_cap","cap_id":"<id>","prompt":"...","repo"?,"branch"?,"reason"?}`. Starts the remote cap `cap_id` headlessly, or resumes it when it already has a session. `cap_id` matches `^[A-Za-z0-9_-]+$`. `repo` and `branch` must not start with `-`. Reply: `cap_result` when the run finishes (it can take minutes), `error` on failure.
- `stop_cap`: `{"bantou":1,"type":"stop_cap","cap_id":"<id>"}`. Stops the running `claude -p` of the remote cap `cap_id` (its whole process group). Reply: `stop_result` (`stopped` is false when the cap was not running), `error` on failure. The interrupted `kick_cap` still gets its own `cap_result` with `ok:false`.
- `status`: `{"bantou":1,"type":"status"}`. Reply: `status_result`.

## Replies (server to peer)

- `cap_result`: `{"bantou":1,"type":"cap_result","cap_id","session_id","ok","result_text","error"?}`. Also sent later, to the center that kicked the cap, when a worker report resumes the cap.
- `stop_result`: `{"bantou":1,"type":"stop_result","ok":true,"cap_id","stopped"}`.
- `status_result`: `{"bantou":1,"type":"status_result","ok":true,"caps":[...],"workers":[...]}`.
- `error`: `{"bantou":1,"type":"error","ok":false,"message","command"?,"cap_id"?,"worker_id"?}`.

## Notices (server to peer)

- `activity`: `{"bantou":1,"type":"activity","cap_id","at","agents":[...]}`. Not a reply: it is never matched with a pending command. Sent to the center that kicked `cap_id`, as a snapshot of the cap and its workers (cap first, then workers by id). Each agent has `kind`, `id`, `cap_id`, `state` (running | stalled | idle | done | failed | lost), `task`, `last_activity`, `last_output_at`, `silent_ms`, `started_at`, `finished_at`, `error`?. Sent every 5 seconds while any agent is running or stalled, and at each state change. Use `silent_ms` for elapsed time, not clock differences. A peer that does not know `activity` ignores it.

## Notes

- The server ignores messages that are not commands. Messages without `meta` are still accepted as the old format.
- The peer id changes when a peer re-registers; replies go to the sender's current peer id.
- Changing this definition requires a new `version` (same name and version with different content is a PROTOCOL_CONFLICT).
