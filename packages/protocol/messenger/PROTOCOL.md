# bantou protocol v2

A center sends messages to a server, and the server answers the sender. The only destinations are a center and a server. The body never names a server or a worker. All messages are one JSON object in the message text. The schemas are in `protocol.json`.

## Meta

Send every message with `meta: {protocol: "bantou", version: "<protocol version>"}`. `version` is the registered protocol version (`protocol.json`, now `2.0.0`). The body field `protocol` is always `"bantou"`.

## Messages (center to server)

- `launch`: `{"protocol":"bantou","callType":"invoke","order":"launch","parent-id":"<cap name>","model":"<worker model>","prompt":"<the work>","ws":"<destination of the center's ws>","schema":{"type":"http","url":"<URL of the center's /mcp/schemas>","headers":{"Authorization":"<value>"}}}`. Starts a worker. `model` is optional; when present it matches `^[A-Za-z0-9._\[\]][A-Za-z0-9._\[\]-]*$`, and when absent the server does not pass `--model`. `schema` is optional; when present it is the JSON object that goes as-is in the `x-schema-discovery` header of openspec-mcp (`type` is `http`, `url` and `headers.Authorization` are non-empty strings). A launch whose `schema` has another shape is not a launch.
- `stop`: `{"protocol":"bantou","callType":"invoke","order":"stop","parent-id":"<cap name>"}`.
- `answer`: `{"protocol":"bantou","callType":"reply","order":"answer","session-id":"<id>","content":"<the answer>"}`.
- `approve`: `{"protocol":"bantou","callType":"reply","order":"approve","session-id":"<id>"}`.
- `reject`: `{"protocol":"bantou","callType":"reply","order":"reject","session-id":"<id>"}`.
- `server-info`: `{"protocol":"bantou","callType":"status","order":"server-info"}`. The server answers with the message below.

## Message (server to the sender of server-info)

- `server-info` answer: `{"protocol":"bantou","callType":"status","order":"server-info","version":"<npm bantou version, x.y.z>"}`.

## callType

`callType` is `invoke`, `reply`, `status` or `exec`. `exec` is accepted as a callType but its `order` is not defined: a message with it is ignored.

## Notes

- A message that does not match one of the 7 shapes above is ignored (this includes every message of protocol 1.x).
- The peer id changes when a peer re-registers; answers go to the sender's current peer id.
- Changing this definition requires a new `version` (same name and version with different content is a PROTOCOL_CONFLICT).
