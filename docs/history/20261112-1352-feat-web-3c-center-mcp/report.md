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

## Review 1: fixes (second commit after `b65119bd18828b4b4ccba57eb51a550c780b36cc`)

Results: `packages/center-client` typecheck ok, test 135 pass / 0 fail (was 112), 3 runs no flake. `packages/web` 38, `packages/protocol` 43.

| # | finding | fix |
|---|---|---|
| 1 | medium: `initialize()` JSON-RPC error not scrubbed | `pickResponse` failure in `initialize` is scrubbed like `requestOnce`. Test: error echoing token and password is clean in `call()`, `connection().lastError`, `refresh().reason` |
| 2 | low: `decodeURIComponent` failure dropped the raw password | new `secretsOf(url, token)`: raw and decoded are pushed separately, decode failure is caught on its own. Test with `ab%zzcd` |
| 3 | low: events `clean` lacked the URL password | `StreamOptions.secretUrl` (the URL with userinfo); `createCenterEvents` passes `target.url`. `streamOnce` uses `scrub` (same secrets as mcp.ts) |
| 4 | low: `createCenterMcp` without policy | fail-closed: `policy.allowTool ?? allowWebTool` (also for `policy: {}`). Pass `allowTool: () => true` to allow all. `McpClient` default unchanged. Tests added |
| 5 | low: `selectTarget` failure text | `call()`, `json()`, `connection()` scrub it with the last known target. `scrub` and `secretsOf` are exported from `index.ts` for 3d / 4a. `scrub` also drops `scheme://user:pass@` left in text |

Tests added (`test/secrets.test.ts`, `test/events-secrets.test.ts`, small edits in `test/events.test.ts`, `test/mcp.test.ts`, `test/helpers/fake-center.ts`):
- mcp: scrub (URL password raw / decoded / undecodable / short), initialize and tools/call JSON-RPC error echo, HTTP 500 body echo for initialize and tools/call (error, `lastError`, log), connect error and read error via injected `fetch`, `log.warn` scrub, `lastError` cleared by success, `tools/call` `log.info`, re-initialize bounded (fake center `limit` turns a runaway retry into HTTP 500 and a count mismatch), fail-closed policy, `selectTarget` failure.
- events: connect error, rejected body, read failure (token and URL password), `logger.warn`, throwing listener, backoff values (injected `reconnectDelayMs` records the failure counts: 0,1,2 then reset to 0), default backoff 1/2/4/8/15 s, `start` idempotent after a delay, `stop` with an open silent connection (read timeout 60 s, so only abort ends it) and restart, token sent, comment lines.
- Hang → assertion: every `createCenterEvents` made by a test is stopped in `afterEach` (a failed test no longer keeps a loop alive), `stop()` and the silent-stream timeout are wrapped in a short `within(...)`, the fake center has a `limit` (HTTP 500 after N requests).

Mutation check (a change put into `src`, test run, change reverted): killed by an assertion, no hang, for: initialize error scrub removed, raw/decode order, `secretUrl` unused, default policy open, `selectTarget` text raw, token not sent on events, only first listener, `stop` without abort, `start` not idempotent, unbounded re-initialize, failures not reset, no read timeout, `lastError` not cleared, no `log.info`, 500 body / `log.warn` / read error / JSON-RPC error not scrubbed, no target follow, no long wait after rejected.
Survived: the `scrub` in `createCenterEvents`' `logger.warn`. It is redundant (the message from `streamOnce` is already scrubbed); kept as a second guard, the warn path is covered by the `logger.warn` test.
Not done: nothing from the list left over. `package.json` description untouched.

## Review 2: fixes (commit after `09664256d6363e0fbdd3ecd4a67405d049e68e6e`)

Results: `packages/center-client` typecheck ok, test 141 pass / 0 fail (was 135), 3 runs no flake. `packages/web` 38, `packages/protocol` 43.

| # | finding | fix |
|---|---|---|
| 1 | `streamOnce` could be called without the secret URL, leaving the URL password in a rejected body | **API change**: `streamOnce(target: { url, token? }, segments, onEvent, opts)`. It takes the configured MCP url (with userinfo) and builds the request URL itself (`centerUrl`), so the password and the token are always known. `StreamOptions.secretUrl` and `StreamOptions.token` are gone; `StreamTarget` is exported. 4a: call it as `streamOnce({ url: mcpUrl, token }, ["sessions", name, "output"], onEvent, { lastEventId, signal })` |
| 2 | `selectFailure` could leak a token when no target was known yet or settings had just changed | I read the settings layer: `selectTarget` errors come from the store (`readFile` / `JSON.parse`, whose message quotes the file) or are `CenterSettingsError` (our fixed texts). So an arbitrary error becomes the fixed text `接続先の選択に失敗` (+ ` (CODE)` when it has an error code like `EACCES`); only a `CenterSettingsError` message is passed on, scrubbed with the last known target. `last` is updated in `call()`, `json()` and `connection()` |
| 3 | `json()` "結果を読めない" quoted the start of the body | fixed text `<tool> の結果を読めない (JSON ではない)`; the list `reason` and the log carry the same text. Test: the body (with a token) appears in none of error, reason, log |
| 4 | "reestablish is tried once only" could hang | `mock.limit` added: a runaway retry gets HTTP 500 and the count assertions fail |
| 5 | missing tests | initialized notification 500 body with token / password (error, `lastError`, log); sessions listener that throws (other listener still called, refresh resolves, cache already stored); events failure count reset on a target move; `stop()` waits for the loop (slow teardown finished when it resolves); `connection()` updates the last known target (CenterSettingsError text scrubbed) |

Mutation check (change put into `src`, test run, reverted; the change was committed first so the revert cannot lose work): killed by an assertion, no hang, for: stream scrub with the built url, `selectFailure` raw (both branches), JSON body quoted, notification not scrubbed, unbounded re-initialize, listener not isolated, no failure reset on move, `stop` not awaiting the loop, `connection()` not updating the last target.

## 3d・desktop 側の注意

- `createCenterMcp` is fail-closed: without `policy.allowTool` the web list (`allowWebTool`) applies. A desktop-like caller that wants every tool must say so with `policy: { allowTool: () => true }`. `McpClient` alone still allows every tool when no policy is given.
- The text of a successful tool result (`call()` / `json()` return value) is passed on as is. It can contain secrets the center put there (for example a session's login URL, or a token echoed by a tool). The 3d route is the gate: it must filter / scrub what it returns to the browser; nothing here does it.
- `scrub` removes a URL password only when it has 4 or more characters, so a shorter password is not removed from free text (a body, a library error). Error texts built by this package use `redactUrl` and never contain the userinfo; only text taken from outside (response bodies, library errors) depends on `scrub`.
