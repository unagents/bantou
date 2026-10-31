# Interfaces: master-cap pty wrapper (wrapper ↔ center, core HTTP, desktop)

Spec of record: docs/design/master-cap-session.md (decisions 1-12). Task: docs/history/20261101-1300-master-cap-wrapper/task.md.

## A. wrapper binary `bantou-pty-wrapper` (crate packages/pty-wrapper)

Invocation: `bantou-pty-wrapper [--cols N] [--rows N] [--cwd DIR] -- <program> [args...]`
- defaults cols=120 rows=40, cwd = current dir. Env is inherited unchanged (token env var passes through).
- Opens pty via `portable-pty`, spawns program in it.
- stdout of wrapper: protocol only, 1 line = 1 JSON object (newline-delimited). stderr: free diagnostics.

wrapper -> center (stdout):
- `{"t":"started","pid":<child pid or null>}` once after spawn.
- `{"t":"output","data":"<base64 of raw pty bytes>"}` per read chunk (raw bytes, may split UTF-8; that is why base64).
- `{"t":"text","data":"<string>"}` same chunk with ANSI/OSC/control sequences removed (keep printable text, \n; drop \r and escapes). Decoded with a streaming UTF-8 decoder (no broken chars across chunks). May be omitted when empty.
- `{"t":"exit","code":<int or null>,"signal":<string or null>}` once when child ends; then wrapper exits (its own exit code 0).

center -> wrapper (stdin, 1 line = 1 JSON):
- `{"t":"input","data":"<base64 bytes>"}` write bytes to pty.
- `{"t":"resize","cols":N,"rows":N}`
- `{"t":"stop"}` terminate child (SIGTERM to child / process group, SIGKILL after ~3s), then emit exit and quit.
- stdin EOF (center died) => same as stop.
- Unknown / malformed line => log to stderr, ignore.

## B. center: wrapper location (decision 12)
- center looks for `bantou-pty-wrapper` (Windows: `.exe`) in `dirname(process.execPath)`.
- Override: env `BANTOU_PTY_WRAPPER=<path>` (dev/test, where execPath is node). Record this addition in report as 要判断事項.

## C. center HTTP (same port, same external Bearer token as /mcp)
- `POST /mcp` external MCP: session_create / session_delete / session_list, remote_list (read only), existing rc_* / server_* / worker_resume. NOT remote_create / remote_delete / cap_kick.
- `POST /mcp/session` session MCP: remote_create / remote_delete / remote_list. Auth = per-session one-time token (generated at each session start, random >= MIN_TOKEN_LEN) as `Authorization: Bearer <t>` AND header `X-Bantou-Session: <name>`; token must belong to that name, else 401. External token => 401. owner = session name from header.
- master-cap launch: wrapper -- claude --remote-control <name> --permission-mode <m> --mcp-config '<json>' (resume: add --continue). JSON: `{"mcpServers":{"bantou":{"type":"http","url":"http://127.0.0.1:<port>/mcp/session","headers":{"Authorization":"Bearer ${BANTOU_SESSION_TOKEN}","X-Bantou-Session":"<name>"}}}}`; env BANTOU_SESSION_TOKEN=<token> given to the wrapper/child. No files written.
- core streaming endpoints (external token):
  - `GET /sessions/<name>/output` SSE. Resume point: header `Last-Event-ID` or query `?after=<id>`. Chunk IDs: integers starting at 1, per session, monotonically increasing, never reused within center process life.
    - If after < oldest-1 (gap; not in queue) or no after given: first send `event: reset\ndata: {}\n\n`, then all queued chunks.
    - Each chunk: `id: <chunkId>\nevent: output\ndata: <base64>\n\n`. Then live chunks as they arrive. Keep-alive comment `: ka\n\n` every 15s.
    - Unknown session => 404.
  - `POST /sessions/<name>/input` body JSON `{"data":"<base64>"}` => 204. Session not running => 409.
  - `POST /sessions/<name>/resize` body `{"cols":N,"rows":N}` => 204; center forwards to wrapper and remembers last size (last sender wins, decision 11).
- core queue per session: 8 MiB cap (sum of decoded bytes), drop oldest chunks. Queue survives wrapper restart within same center process (IDs continue).

## D. desktop
- Rust: SSE client per selected session -> Tauri event `session-output` payload `{session, id, data(base64), reset:bool}`; commands `session_input(session, data_b64)`, `session_resize(session, cols, rows)` POST to center. Webview never contacts center directly.
- Front: per-session buffer 2 MiB, keep last received chunk id; on reset, clear and repaint.

## E. task-add-1: session list = center `session_list` (added 2026-11-01)

- center: `GET /events` SSE (external Bearer token, same port). On connect send `event: sessions\ndata: {}\n\n` once; whenever a session is added or removed in the center (session_create / session_delete / restore at startup) send `event: sessions\ndata: {"reason":"created"|"deleted"|"restored","name":"<name>"}\n\n`. Keep-alive comment `: ka\n\n` every 15s. No event IDs / no replay (desktop re-fetches `session_list` on each event and on reconnect).
- desktop: side menu list = result of `session_list` of the connected center (own sidecar or pasted remote center). Drop the in-memory "added" list (`session.rs` `Sessions`, `add_sessions`, `reconcile` lost judgement). Refetch at: before operations, sleep wake, network change, settings close, every 5 min, and on each `sessions` event from `GET /events` (Rust subscribes, forwards to webview as Tauri event `center-sessions-changed`). If center is unreachable, show the last fetched list with an "unreachable" indicator. "Add session" = create only (`session_create`); remove the pick-from-list add screen.
