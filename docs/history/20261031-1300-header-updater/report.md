# Report: Header updater control (cmux style)

- Date: 2026-10-31 / Executed by: 204 remote cap (workers: sonnet for the implementation and the E2E attempt, opus for the review; Fable not used)
- Branch: develop

## Changes (desktop/)

- `src/components/AppHeader.vue`: Adds one updater control (`data-testid="updater-control"`) to the header. It sits outside the `workspacePath` condition, so it shows when no folder is selected. The label changes with the state:
  - idle: "アップデートを確認"
  - checking: "確認中…"
  - latest: "最新"
  - available: "アップデートして再起動（v<ver>）"
  - downloading: shows progress
  - installing: "再起動します…"
  - error: shows the reason (clicking runs the check again)
- `src/composables/useUpdater.ts`: No longer uses the toast. A manual check that finds no update sets `latest` and returns to idle after 2 seconds. A failed manual check sets `error` with the reason. The startup auto-check stays silent unless it finds an update, in which case it sets `available`. The app menu item "アップデートを確認..." still drives the same state through the existing event listener.
- `src/types/index.ts`: Adds `{kind:"latest"}` to `UpdaterState`. `error.version` is now `string | null`.
- `src/pages/index.vue`: Now calls `useUpdater()` and passes the state to AppHeader. This used to be done in app.vue.
- `src/app.vue`: Removes the `useUpdater` call and `UpdaterToast`.
- `src/components/UpdaterToast.vue`: Deleted.
- `e2e/updater.spec.ts`: Replaced to match the spec:
  - idle, then check, then latest, then back to idle
  - update available: the header button switches to the available state; clicking it calls `download_and_install` and `restart`
  - the control is shown when no folder is selected
- `e2e/mock/bantou.ts`: Unchanged. The existing `update` seed and the `plugin:updater|*` / `plugin:process|restart` mocks were enough.

## Verification

- E2E: **not run.**
  - On this host (204), there is no system Chrome (the config uses `channel: "chrome"`). In the sandbox, `nuxt dev` fails with `listen EPERM ... nitro-worker-*.sock`.
  - Running outside the sandbox was refused by the auto-mode classifier.
  - mac200, the documented E2E host, is unreachable for this user (uid 1002 `claudeAgent`): `/home/vagrant/.ssh/known_hosts: Permission denied`, then `Host key verification failed`.
- `bun run typecheck`: **fails because of the environment.** The error is `Cannot find module 'vue-router/volar/sfc-route-blocks'`. The same failure happens on the unchanged tree (checked with `git stash`), so this change does not cause it.
- Read-only review (opus) of the diff against task.md and the e2e mock:
  - No bugs found. Verdict: ship with notes.
  - Every spec state is present.
  - The no-folder state really is produced (`dir: null`).
  - The test IDs and labels match AppHeader exactly.
  - The menu listener is registered once per window.
- cargo: not needed (no Rust change).
- **Still required:** run `bun run e2e` on mac200 per `desktop/CLAUDE.md` before release.

## Open items (not done; need a user decision)

- `desktop/README.md:35-36` still describes the old toast behavior ("bantou は最新です", and the "再起動して更新" / "リリースノート" buttons in the notification). This change makes that text inconsistent. It is not fixed yet because it is outside the scope of the instructions.
- Orphans left by removing the toast:
  - `useUpdater.dismiss()` (`useUpdater.ts:89`, with an outdated comment)
  - `openReleaseNotes` (`api/updater.ts:30`)
  - as a result, the opener plugin: `@tauri-apps/plugin-opener`, `tauri-plugin-opener` (Cargo.toml / lib.rs:59), and `opener:default` in capabilities

  They are left as they are.
- The link to the release notes is gone. The spec does not require one.
- Minor review notes:
  - While the startup auto-check runs, the control also shows "確認中…" and cannot be clicked.
  - Clicking the control after an install error runs a new check, not an install retry.
  - There is no e2e test for the menu path or for the error display.

## Processes and temporary files

- Processes: the worker started `nuxt dev` twice; both exited. Final check: `pgrep` found no nuxt, playwright, or chrome processes, and port 1420 is free.
- mac200: nothing was created, because the connection failed.
- **Leftover temporary files (deleting them was refused by permission):**
  - `desktop/playwright.tmp.config.ts` (untracked, not committed)
  - `/tmp/claude-1002/nuxt.log`
