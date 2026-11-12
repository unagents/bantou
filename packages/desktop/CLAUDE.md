# bantou

## UI の置き場所

- 画面の共有部品（components / composables / types / api / assets）は `packages/ui/`（Nuxt layer）にある。desktop は `nuxt.config.ts` の `extends: ["../ui"]` で取り込む。共有部品の変更も下の Review check（e2e）の対象。
- `packages/ui/` の file は Tauri の package を import しない。`~/tauri`（desktop では `src/tauri/`）経由にする。`@tauri-apps` を import してよいのは `src/tauri/` だけ。
- desktop 側の file から ui の file を参照する時は alias `#bantou-ui` を使う（例: `#bantou-ui/api`）。ui 内では `~/` が利用側 project 基準になるため、ui 内の相対 import に `~/` を使わない（`~/tauri` を除く）。
- `pages/index.vue` の選択・フィルタ・ダイアログ管理は `packages/ui/composables/useSessionBoard.ts`。3 カラムの配置は `pages/index.vue` に残る。

## Review check (before release)

Run E2E on mac200, never on this Mac.

1. Sync the whole repo (run from the repo root, not `packages/desktop/`):
   `rsync -a --delete --exclude node_modules --exclude target --exclude .nuxt --exclude .output --exclude .git --exclude src-tauri/binaries ./ claude-cli@192.168.1.200:work/bantou-mono/`
2. Build and install there:
   `ssh claude-cli@192.168.1.200 'cd work/bantou-mono/packages/protocol && npm run build'`
   `ssh claude-cli@192.168.1.200 'cd work/bantou-mono && bun install'`
3. Run the tests there (in `packages/desktop/`):
   `ssh claude-cli@192.168.1.200 'cd work/bantou-mono/packages/desktop && bun run e2e'`
   Chrome launch failures show as `flaky` and are absorbed by retries. Only `failed` counts.
4. Copy the screenshots back and look at them yourself before reporting:
   `scp claude-cli@192.168.1.200:work/bantou-mono/packages/desktop/node_modules/.cache/bantou-e2e/shots/board.png /tmp/claude/`
   Other shots: `modal.png`, `answered.png`, `session-added.png`.
5. Rust (in `packages/desktop/`): `cd src-tauri && cargo test`.
   sidecar binary が無いとビルドが失敗する。先に `bun run build:sidecar`（`src-tauri/binaries/bantou-center-<triple>`）。

## center sidecar

- `bun run build:sidecar` は `tauri dev` / `cargo` の前に必須。universal mac ビルドは両 darwin triple（`--target`）が要る。`tauri build` は `beforeBuildCommand` で実行する。
- 設定は設定ダイアログ（ヘッダーの歯車）。`settings.json` の `center` キーに保存し、`~/.local/share/bantou/center.json` を書き出す。項目は README 参照。

## Release / deploy

Do it without asking once the review check passes. The release runs on mac200 (claude-cli) with `packages/desktop/scripts/release.sh`.

0. When `packages/protocol/messenger/` (`protocol.json` / `PROTOCOL.md`) changed: the protocol `version` must be raised and `versions.json` extended (`packages/protocol/test/versions.test.mjs` checks it). The center only talks to servers on the exact same protocol version, so publish the server first (step 1), then release the desktop.
1. When `packages/server/` changed: the desktop embeds `packages/server/package.json`'s version as its paired server version (`build-sidecar.ts`). Bump `packages/server/package.json` on develop; otherwise centers ask servers for an unpublished version and show `failed`. The script runs the server tests and publishes the server to npm (before pushing) when that version is not on npm yet. npm on mac200 (claude-cli) is logged in.
2. Sync the repo to mac200 (review check step 1), then run the script there:
   `ssh claude-cli@192.168.1.200 work/bantou-mono/packages/desktop/scripts/release.sh <ver>` (`release.sh --dry-run <ver>` stops before any push or publish).
   It clones develop into `/tmp/bantou-rel-<ver>`, runs e2e and `cargo test` (and the server tests when the server is published), bumps `bun.lock`, `package.json`, `Cargo.toml` and `Cargo.lock`, builds signed, writes `latest.json`, pushes develop and fast-forwards main, creates the GitHub release (dmg, `bantou.app.tar.gz`, `.sig`, `latest.json`), publishes the cask (`publish-cask.sh`), commits the cask, removes the clone, and swaps and restarts the app on mac200.
   The updater key (`~/.tauri/bantou-updater.key`, no password) is on this Mac and on mac200 (claude-cli) only; never copy it anywhere else. gh on mac200 (claude-cli) is logged in to GitHub. Gitea `gitea` is a read-only pull mirror, never push there.
   `publish-cask.sh` aborts when the tap file differs by more than version/sha256. When `Casks/bantou.rb` itself changed (lines added or removed), run it by hand with `--force` and check the printed diff.
3. This Mac (tap `unagents/tap`): `/opt/homebrew/bin/brew update` and `/opt/homebrew/bin/brew upgrade --cask bantou`. Use `/opt/homebrew/bin/brew`, never `/usr/local/bin/brew`.
4. Restart the app: `pgrep -fl 'bantou.app/Contents/MacOS'`, `kill <pid>` (by PID only), `open -a /Applications/bantou.app`. Check `CFBundleShortVersionString` in `/Applications/bantou.app/Contents/Info.plist`.

Network commands (ssh, rsync, curl, cargo build, brew) need the Bash sandbox off.
