# bantou

## Review check (before release)

Run E2E on mac200, never on this Mac.

1. Sync the whole repo (run from the repo root, not `desktop/`):
   `rsync -a --delete --exclude node_modules --exclude target --exclude .nuxt --exclude .output --exclude .git --exclude src-tauri/binaries ./ claude-cli@192.168.1.200:work/bantou-mono/`
2. Build and install there:
   `ssh claude-cli@192.168.1.200 'cd work/bantou-mono/packages/protocol && npm run build'`
   `ssh claude-cli@192.168.1.200 'cd work/bantou-mono && bun install'`
3. Run the tests there (in `desktop/`):
   `ssh claude-cli@192.168.1.200 'cd work/bantou-mono/desktop && bun run e2e'`
   Chrome launch failures show as `flaky` and are absorbed by retries. Only `failed` counts.
4. Copy the screenshots back and look at them yourself before reporting:
   `scp claude-cli@192.168.1.200:work/bantou-mono/desktop/node_modules/.cache/bantou-e2e/shots/board.png /tmp/claude/`
   Other shots: `modal.png`, `answered.png`, `session-added.png`.
5. Rust (in `desktop/`): `cd src-tauri && cargo test`.
   sidecar binary が無いとビルドが失敗する。先に `bun run build:sidecar`（`src-tauri/binaries/bantou-center-<triple>`）。

## center sidecar

- `bun run build:sidecar` は `tauri dev` / `cargo` の前に必須。universal mac ビルドは両 darwin triple（`--target`）が要る。`tauri build` は `beforeBuildCommand` で実行する。
- 設定は設定ダイアログ（ヘッダーの歯車）。`settings.json` の `center` キーに保存し、`~/.local/share/bantou/center.json` を書き出す。項目は README 参照。

## Release / deploy

Do it without asking once the review check passes. The release runs on mac200 (claude-cli) with `scripts/release.sh`.

1. When `server/` changed: the desktop embeds `server/package.json`'s version as its paired server version (`build-sidecar.ts`). Bump `server/package.json` on develop and `npm publish` the server **before** the release; otherwise centers ask servers for an unpublished version and show `failed`. The script does not do this.
2. Sync the repo to mac200 (review check step 1), then run the script there:
   `ssh claude-cli@192.168.1.200 work/bantou-mono/desktop/scripts/release.sh <ver>` (`release.sh --dry-run <ver>` stops before any push or publish).
   It clones develop into `/tmp/bantou-rel-<ver>`, runs e2e and `cargo test`, bumps `bun.lock`, `package.json`, `Cargo.toml` and `Cargo.lock`, builds signed, writes `latest.json`, pushes develop and fast-forwards main, creates the GitHub release (dmg, `bantou.app.tar.gz`, `.sig`, `latest.json`), publishes the cask (`publish-cask.sh`), commits the cask, removes the clone, and swaps and restarts the app on mac200.
   The updater key (`~/.tauri/bantou-updater.key`, no password) is on this Mac and on mac200 (claude-cli) only; never copy it anywhere else. gh on mac200 (claude-cli) is logged in to GitHub. Gitea `gitea` is a read-only pull mirror, never push there.
   `publish-cask.sh` aborts when the tap file differs by more than version/sha256. When `Casks/bantou.rb` itself changed (lines added or removed), run it by hand with `--force` and check the printed diff.
3. This Mac (tap `unagents/tap`): `/opt/homebrew/bin/brew update` and `/opt/homebrew/bin/brew upgrade --cask bantou`. Use `/opt/homebrew/bin/brew`, never `/usr/local/bin/brew`.
4. Restart the app: `pgrep -fl 'bantou.app/Contents/MacOS'`, `kill <pid>` (by PID only), `open -a /Applications/bantou.app`. Check `CFBundleShortVersionString` in `/Applications/bantou.app/Contents/Info.plist`.

Network commands (ssh, rsync, curl, cargo build, brew) need the Bash sandbox off.
