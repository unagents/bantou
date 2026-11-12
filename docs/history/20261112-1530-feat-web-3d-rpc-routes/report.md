# feat/web-3d-rpc-routes (work unit 3d)

- Branch: `feat/web-3d-rpc-routes`, based on origin/develop `a507dc0` (merge of 3c).
- Code commit: `789a4bf6ee50f326da26db3e2fab8eb6cb5e05fb`. This report is in the commit after it (the branch HEAD; its full SHA is in the report sent to the cap).
- Design: `docs/history/20261111-2342-web-app-design/design.md` (on `docs/web-app-design`, HEAD `db7a9f7e659dff08dedf614ae0d48cdfbed17f42`) 4, 5.1-5.5, 5.7, 10.2 "3d". Not copied into this branch.

## Added

| where | what |
|---|---|
| `center-client/src/commands.ts` | command table (`createCommands`): `center_get_settings` `center_set_settings` `center_call` `center_connection` `list_sessions` `refresh_sessions` `create_session` `session_update` `session_get_settings` `session_update_settings` `session_path_hints`. Arg builders ported from `session.rs` (`create_args` `rename_args` `update_args` `normalize_settings` `settings_of` `workspace_of`). `canPick` is always false. Keys of the table = allow-list of commands |
| `center-client/src/redact.ts` | `createRedactor`: cleans text / JSON of the token and URL password of every target seen (and of a settings input), raw and JSON-escaped, plus any `scheme://user:pass@` |
| `center-client/src/client.ts` | `createCenterClient`: the assembly (below), `rpc`, `health`, `subscribe`, `openEventStream` |
| `web/server/utils/center/client.ts` | `getCenterClient()`: memoized, one per process |
| `web/server/api/rpc/[cmd].post.ts`, `events.get.ts`, `health.get.ts` | thin routes |
| tests | `center-client/test/commands.test.ts` (Rust test inputs, with `S:` marks), `client.test.ts` (rpc, redaction, health, fan-out), `web/test/server/nitro-wiring.test.ts` (+8 tests on the built server) |

## center-client assembly: the shape (for 4b)

```ts
import { createCenterClient, type CenterClient } from "bantou-center-client";
const c = createCenterClient({ settingsStore?, settingsFile?, env?, fetch?, logger?, allowSettingsWrite?, keepAliveMs? });
c.settings   // CenterSettingsHandle (redactSecrets: true, policy.allowEnabled: false)
c.mcp        // CenterMcp (policy.allowTool = allowWebTool)
c.sessions   // SessionService
c.events     // CenterEvents (started on the first subscribe)
c.commands   // frozen table name -> handler(args)
c.redactor   // text() / value() / textSync() / note()
c.rpc(cmd, bodyText) -> { status, body }      // never throws
c.health() -> { status: "ok"|"no-target"|"unreachable", connected, source?, host?, reason? }
c.subscribe(listener) / c.openEventStream() -> { readable, close }
c.close()
```

- web side: `getCenterClient()` in `packages/web/server/utils/center/client.ts` (explicit import, in a subdir so Nitro does not auto-import it under a top-level name). 4b should call it, not build its own.
- Terminal (4a is not on develop): not included. 4a adds `terminal` to the `CenterClient` interface and to the return of `createCenterClient`, built from `settings` and using `redactor`. Nothing else needs to change.
- Settings file: `WEB_SETTINGS_FILE`, else `$XDG_STATE_HOME/bantou-web/settings.json`, else `~/.local/state/bantou-web/settings.json`. The design says only "backend の状態 dir", so this default is my choice.

## RPC contract (5a must match)

- `POST /api/rpc/:cmd`, body = the args object itself (the second argument of `invoke`, camelCase keys as `ui/api` sends them, e.g. `{ name, newName, path, moveDir }`). Empty body = no args. Design says "body は JSON の args"; I read it as the object, not `{ "args": ... }`.
- 200 + JSON result (`null` for no result). Failure: HTTP status + `{ "error": "<string>" }` (the desktop's rejection is a plain string). 404 unknown command / tool not allowed, 400 bad args, 403 settings write gate, 413 body over 1 MiB, 502 center / network, 500 anything else (fixed text).
- Only own keys of the table are commands (`constructor`, `__proto__` give 404).

## Differences from the design / decisions

- Decision 14 gate: `center_set_settings` is refused (403) always, from the route. `allowSettingsWrite` exists in `createCenterClient` (unit-tested open) but the web does not pass it and there is no env switch. Opening it is one line in `getCenterClient()` after the user decides.
- `center_status` / `center_regenerate_token` are not commands (work unit S): 404.
- Redaction is by known secrets (token, URL password of targets seen since start, and those of a settings input). I did not add key-name based masking (e.g. any `*token*` key): the center's settings / session settings carry no secrets by the center's schema (`servers` are names), and a name guess could garble real data.
- `/api/health` returns the destination host only (no path), plus `reason` (scrubbed).
- Events are sent as `event: center-sessions-changed` (`{reason,name}`) and `event: bantou://sessions-changed` (`null`), the desktop's names. Keep-alive comment every 15 s, `X-Accel-Buffering: no`, `Cache-Control: no-cache, no-transform`.
- Body size is checked after reading (1 MiB cap); a larger body is read before it is refused.

## Shared files touched (for 4b)

- `packages/web/package.json`: `dependencies: { "bantou-center-client": "workspace:*" }`.
- `bun.lock`: the matching 3 lines only (`packages/server` version line that `bun install` rewrote was restored).
- `packages/web/tsconfig.json`: `include` + `../center-client/src/ui-types-shim.d.ts` (center-client imports `packages/ui/types`, which names the `~/tauri` alias).
- `packages/center-client/src/index.ts`: export block appended at the end.
- `packages/web/test/server/nitro-wiring.test.ts`: the spawn env gets `WEB_SETTINGS_FILE` (a temp dir that the test removes); fake center and child log capture added in the same `describe`; 8 tests appended. Existing tests untouched.
- Not touched: `nuxt.config.ts`, `packages/ui`, `package.json` of center-client, Rust, protocol, center, desktop, versions.

## Results

- `packages/web`: typecheck ok, test 48 pass / 0 fail (was 38; +8 in the first commit, +2 body-cap tests in the review fix).
- `packages/center-client`: typecheck ok, test 180 pass / 0 fail (was 141; +17 first commit, +22 review fix).
- `packages/protocol`: 43 pass.
- Wiring test checks: new routes behind the guard (no key 403 / no JWT 401 / other email 403 / bad Origin 403), start without a settings file and health says `no-target`, the settings file written later is used without restart, unknown command and tool (`server_retire`, `session_delete`) 404 with nothing sent to the center, set_settings 403 and file unchanged, token / URL password absent from health, get_settings, a tool body, error bodies and the server's stdout/stderr, SSE reaches two clients with one events connection to the center.
- Fake centers listen on 127.0.0.1 with a free port.

## Notes

- Not done: real-center check (no real center was used); `session_attach_*` / terminal commands (4a / 4b).
- Clean-up of this clone is done with `mcp__bantou__bash` rm (relative paths).

## Review fix (L1-L3)

Code commits after `17a8ad4`: `1bb8b4d` (spellings, body cap, tests) and `6df3be1` (log lines, SSE target read). The branch HEAD is the report commit after them (full SHA in the report sent to the cap).

- L1 spellings: new `src/secrets.ts` (`maskSecrets`, `formsOf`). A secret is also masked in other letter case, percent-encoded (`encodeURIComponent`), base64 (standard and url-safe, all 3 byte alignments, so also inside a longer base64 text), `\uXXXX` and JSON-escaped (`"`, `\`) forms. A secret under 4 chars (the existing minimum for derived forms, same as the URL password rule) is masked in its exact form only. `mcp.ts` `scrub` and `redact.ts` both use it, so the rpc result, rpc error, health reason, SSE body and logs are covered.
- Found while testing: an SSE event could be sent before any rpc, when the redactor had not seen the target yet, so the token was not masked in the stream. The stream now reads the target for every event (one promise chain keeps the order). The logger given to `createCenterClient` is wrapped so every log line (mcp, sessions, events, rpc) passes the redactor; a secret noted from a settings input was missing from the mcp log lines before.
- L2 body cap: new `src/body.ts` `readBodyLimited`. `Content-Length` over 1 MiB: not read, 413. Chunked: counted while it arrives, nothing kept after the cap, the rest dropped up to 4x the cap, then reading stops. 413 carries `Connection: close`. The route calls it instead of `readRawBody`.
- L3 tests: `secret-forms.test.ts`, `body.test.ts`, 8 more in `client.test.ts` (special-char token, case, base64, URL-encoded, \u, health reason, rpc error, rpc result, SSE, log), 2 in the wiring test (Content-Length 400000000 with no body bytes; chunked 1.25 MiB; both 413, with a 5 s timeout that fails by assertion). Streams are closed in `finally` so a failed assertion does not hang.
- Mutations (change put in, tests run, reverted; all killed by an assertion, no hang): no URL-encode form (2 fail), no JSON-escape form (2), no \u form (1), no base64 forms (5), case-sensitive match (9), health without redactor (1), rpc error without redactor (1), rpc result without redactor (3), SSE without redactor (2), logger wrapper off for warn (1), no Content-Length check in `readBodyLimited` (1), no counting (1); route using `readRawBody` again: the wiring test "Content-Length 超過" fails after 5 s.
- Mutations not killed: the logger wrapper for `info` (no secret reaches an info line that I could build); the rpc warn line's own redactor (the wrapped logger covers it). The chunked wiring test passes with `readRawBody` (rpc() still refuses a body over the cap after reading it): only the memory use differs; the Content-Length test is the one that detects it.

Results after the fix: web typecheck ok, 48 pass; center-client typecheck ok, 180 pass; protocol 43 pass.

## Remaining (not fixed, by decision)

- L4: other methods on `/api/rpc/:cmd`, `/api/health` and `/api/events` (GET on rpc, POST on health) get the SPA fallback 200 after the guard. No data is returned. Left as is.
