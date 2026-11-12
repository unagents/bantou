# feat/web-3b-center-client review fix (N1 / N2 / N3)

## N1: unknown keys in a saved input

- `validateSettings` built its result by spreading the input, so any extra own property reached the file.
- Fix: `validateSettings` and `toStored` now copy only the known items (`enabled` `port` `workspace` `token` `claudePath` `remote.url` `remote.token`).
- Decision: drop, not reject. The desktop (serde) drops unknown keys, `parseStored` already drops them on read, and the UI sends back what `get` returned (`tokenSet` etc.), so rejecting would break that round trip.

## N2: token saved under another destination

- Case: file `{url A}`, env `CENTER_URL=B`. `set(B, new token)` was saved as `{url A, new token}`; removing env then sent that token to A.
- Fix: when env fixes the url and the file url differs from it, a changed token in the input is refused with `CenterSettingsError` and nothing is written. An unchanged token (empty with `redactSecrets`; same as the stored one without) still saves the other items; the file url and token stay paired.
- Decision: refuse, not rewrite the file url to B. Rewriting would let a screen action change the file destination while env hides it (against 5.5 "env wins, not changeable" and R29). Refusing keeps one rule: a token is only ever stored under the url it was entered for. Same-url case (env url equals file url) is unchanged.
## N3: tests added (7)

- N1: extra keys (top level, `remote`, own `__proto__`) never reach the file; extra keys in the file are not written back.
- N2: reproduction (both `redactSecrets` modes), unchanged token path, env url equal to file url.
- `redactSecrets` false + shown-form url: treated as a different url; env url fixed + shown-form input: accepted as the same destination, stored form kept; other url refused.
- Without the fix, the N1 test and both N2 tests fail (checked by stashing `src`).

## Difference from the design doc (設計書との差)

- Design 5.5 says env wins over the file for `remote` and is silent on the token pairing. Decision (follow-up): the file token is used with the env url only when the file has no remote or its url is the same destination as the env url (compared normalized). With another file url, no file token is sent (the connection has no token; `CENTER_TOKEN` from env is used if set). Reason: a token belongs to the destination it was stored for (R29; same as N2).
- `tokenSet` / `remote.tokenSet` follow the token that is really sent: false when the file token is not used and env has no token; true when `CENTER_TOKEN` is set. The screen then shows "no token" for the env destination, which is what the connection does. The stored file token is untouched and stays under its own url.
- `set` with env url different from the file url: a token in the input is refused (any mode); an input without a token leaves the file remote (url and token) as it is, since the client never saw that token.
