# feat/web-3c-center-mcp (work unit 3c)

- Branch: `feat/web-3c-center-mcp`, based on origin/develop `5d0511b8ce7e0e9cc2a174e5f2e9f5bbc4c6032d`.
- Code commit: `b80daebaeb5447e82cfde64fa0cc0a0812ebbe24`. This report is in the commit after it (that commit is the branch HEAD; its full SHA is in the report sent to the cap).
- Design: `docs/history/20261111-2342-web-app-design/design.md` (on `docs/web-app-design`) 5.1, 5.3, 5.4, 5.6, 10.2 "3c". Not copied into this branch.

## What was added (`packages/center-client`)

| file | role | Rust counterpart |
|---|---|---|
| `src/mcp.ts` | `McpClient` (one session, one re-initialize on 404, 401 text, `lastError`, `probe`), `createCenterMcp` (bound to `selectTarget()`, `call` / `json` / `connection`) | `center_mcp.rs` |
| `src/tool-policy.ts` | `WEB_ALLOWED_TOOLS`, `allowWebTool` | design 5.3 |
| `src/sessions.ts` | `parseSession(s)`, `applyListing`, `SessionCache` (`rev`), `createSessionService` (`get` / `refresh` / `onChanged`) | `session.rs` (list part) |
| `src/events.ts` | `SseParser`, `centerUrl` / `eventsUrl`, `streamOnce`, `toChanged`, `createCenterEvents` (one `GET /events`, many listeners, follows the target) | `center_events.rs`, SSE parts of `terminal.rs` |
| `test/{mcp,sessions,events}.test.ts`, `test/helpers/fake-center.ts` | ports of the Rust tests (each test name carries the Rust line, e.g. `M:757`) + new tests; fake center = `node:http` on 127.0.0.1 | |

Target and token come from `selectTarget()` (`CenterSettingsHandle.selectTarget`), passed as `settings: { selectTarget }`. Nothing rebuilds url or token.

## Results

- `packages/center-client`: typecheck ok; test 112 pass / 0 fail (was 55); 3 runs, no flake.
- `packages/web` 38 pass, `packages/protocol` 43 pass.
- `packages/server` and `packages/center` tests were not run: nothing they use was changed (no other package imports `center-client`).
- Rust, protocol, `packages/center`, `bun.lock`, versions: unchanged.

## Shared files touched (for the 4a worker)

- `src/index.ts`: appended export blocks at the end (tool-policy, mcp, sessions, events). Existing lines untouched.
- `src/settings.ts`: `SettingsPolicy` gained `allowTool?: (name: string) => boolean` (2 lines). `allowEnabled` untouched.
- `package.json`: not touched. No new dependency (uses `fetch`, `node:http` in tests).
- Names the 4a worker may collide with: exports `SseParser`, `SseEvent`, `StreamEnd`, `streamOnce`, `centerUrl`, `reconnectDelayMs` are in `src/events.ts`; 4a can import them for the terminal output stream instead of writing its own. `McpToolResult` is exported from `mcp.ts` (the ui type of the same name is separate).

## Differences from the design / from Rust, and why

- Scope of `session.rs`: only the list part (cache, `rev`, parse). `normalize_settings` / `create_args` / `rename_args` / `update_args` / `settings_of` / `workspace_of` / `create_session` / `session_update` / `session_path_hints` are command handlers: left to 3d.
- `allowTool` is enforced inside `McpClient.callTool` (throws `ToolNotAllowedError`, nothing sent, `lastError` untouched), so internal calls are checked too. Design 5.1 says "許可リスト外は 404" for `/api/rpc/:cmd`: that is about command names and stays with 3d.
- URL userinfo: `fetch` refuses a URL with credentials, so the userinfo is dropped before sending (reqwest turns it into Basic auth; here only the Bearer token is sent). Error text and logs never carry it.
- Secrets: Rust puts the raw url in the 401 text and connect error; here every url in text goes through `redactUrl`, and `scrub` removes the token and the URL password from free text (library errors, response bodies, tool-error text). `CenterConnection.url` is `redactUrl`-ed (Rust returns it raw).
- Timeouts: `AbortSignal.timeout` covers the whole request (connect + body), like reqwest's per-request timeout; the separate 5 s connect timeout does not exist in `fetch`. Timeouts are options.
- `session_list` read errors (not a list, bad type) set `reachable: false` with `session_list の結果を読めない: ...`, as Rust.
- Not done: the `live_center` test (needs a real center).
- `package.json` description still says "Settings part only for now" (not changed on purpose; a one-line follow-up).
