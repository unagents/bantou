# bantou protocol

bantou-server is the listener of this protocol. A center (or any peer) sends a command to the server and the server replies to the sender. All messages are one JSON object in the message text. The schemas are in `protocol.json`.

## Discovery and meta

- Find servers with `list_peers` and `protocol: "bantou"`.
- Send every message with `meta: {protocol: "bantou", version: "<protocol version>"}`. The server replies with the same meta.
- `version` is the registered protocol version (this file's `protocol.json`), not the body field `bantou`. The body always carries `"bantou": 1`.

## Commands (peer to server)

- `kick_cap`: `{"bantou":1,"type":"kick_cap","cap_id":"<id>","prompt":"...","repo"?,"branch"?,"reason"?}`. Starts the remote cap `cap_id` headlessly, or resumes it when it already has a session. `cap_id` matches `^[A-Za-z0-9_-]+$`. `repo` and `branch` must not start with `-`. Reply: `cap_result` when the run finishes (it can take minutes), `error` on failure.
- `status`: `{"bantou":1,"type":"status"}`. Reply: `status_result`.

## Replies (server to peer)

- `cap_result`: `{"bantou":1,"type":"cap_result","cap_id","session_id","ok","result_text","error"?}`. Also sent later, to the center that kicked the cap, when a worker report resumes the cap.
- `status_result`: `{"bantou":1,"type":"status_result","ok":true,"caps":[...],"workers":[...]}`.
- `error`: `{"bantou":1,"type":"error","ok":false,"message","command"?,"cap_id"?,"worker_id"?}`.

## Notes

- The server ignores messages that are not commands. Messages without `meta` are still accepted as the old format.
- The peer id changes when a peer re-registers; replies go to the sender's current peer id.
- Changing this definition requires a new `version` (same name and version with different content is a PROTOCOL_CONFLICT).
