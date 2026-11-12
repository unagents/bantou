# feat/web-3b-center-client review fix (N1 / N2 / N3)

## N1: unknown keys in a saved input

- `validateSettings` built its result by spreading the input, so any extra own property reached the file.
- Fix: `validateSettings` and `toStored` now copy only the known items (`enabled` `port` `workspace` `token` `claudePath` `remote.url` `remote.token`).
- Decision: drop, not reject. The desktop (serde) drops unknown keys, `parseStored` already drops them on read, and the UI sends back what `get` returned (`tokenSet` etc.), so rejecting would break that round trip.

## N2: token saved under another destination

- Case: file `{url A}`, env `CENTER_URL=B`. `set(B, new token)` was saved as `{url A, new token}`; removing env then sent that token to A.
- Fix: when env fixes the url and the file url differs from it, a changed token in the input is refused with `CenterSettingsError` and nothing is written. An unchanged token (empty with `redactSecrets`; same as the stored one without) still saves the other items; the file url and token stay paired.
- Decision: refuse, not rewrite the file url to B. Rewriting would let a screen action change the file destination while env hides it (against 5.5 "env wins, not changeable" and R29). Refusing keeps one rule: a token is only ever stored under the url it was entered for. Same-url case (env url equals file url) is unchanged.
- Not changed (reported only): `effective()` still pairs the file token with the env url when only `CENTER_URL` is set (existing test "only CENTER_URL fixes the url, the file token is used with it"). That is a read-time pairing, not a write.

## N3: tests added (7)

- N1: extra keys (top level, `remote`, own `__proto__`) never reach the file; extra keys in the file are not written back.
- N2: reproduction (both `redactSecrets` modes), unchanged token path, env url equal to file url.
- `redactSecrets` false + shown-form url: treated as a different url; env url fixed + shown-form input: accepted as the same destination, stored form kept; other url refused.
- Without the fix, the N1 test and both N2 tests fail (checked by stashing `src`).
