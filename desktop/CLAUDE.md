# bantou

## Review check (before release)

Run E2E on mac200, never on this Mac.

1. Sync the tree:
   `rsync -a --exclude node_modules --exclude target --exclude .nuxt --exclude .output --exclude .git ./ claude-cli@192.168.1.200:work/bantou/`
2. Run the tests there:
   `ssh claude-cli@192.168.1.200 'cd work/bantou && bun run e2e'`
   Chrome launch failures show as `flaky` and are absorbed by retries. Only `failed` counts.
3. Copy the screenshots back and look at them yourself before reporting:
   `scp claude-cli@192.168.1.200:work/bantou/node_modules/.cache/bantou-e2e/shots/board.png /tmp/claude/`
   Other shots: `modal.png`, `answered.png`, `session-added.png`.
4. Rust: `cd src-tauri && cargo test`.
   sidecar binary が無いとビルドが失敗する。先に `bun run build:sidecar`（`src-tauri/binaries/bantou-center-<triple>`）。

## center sidecar

- `bun run build:sidecar` は `tauri dev` / `cargo` の前に必須。universal mac ビルドは両 darwin triple（`--target`）が要る。`tauri build` は `beforeBuildCommand` で実行する。
- 設定は設定ダイアログ（ヘッダーの歯車）。`settings.json` の `center` キーに保存し、`~/.local/share/bantou/center.json` を書き出す。項目は README 参照。

## Release / deploy

Do it without asking once the review check passes.

1. Bump the version in `package.json` and `src-tauri/Cargo.toml`. Commit on develop.
2. Push to GitHub (remote `github`, or `origin` once switched): `git push <remote> develop`, fast-forward main (`git merge --ff-only develop`), `git push <remote> main`, back to develop.
3. Build: `CI=true bun run tauri build`. Output: `src-tauri/target/release/bundle/dmg/bantou_<ver>_aarch64.dmg`.
4. GitHub release: `gh release create v<ver> <dmg> --title v<ver> --notes ""`
5. Cask: `scripts/publish-cask.sh <ver> $(shasum -a 256 <dmg> | cut -d' ' -f1)`.
   Updates `desktop/Casks/bantou.rb` and updates `Casks/bantou.rb` in GitHub `unagents/homebrew-tap` via API.
6. This Mac (tap `unagents/tap`): `/opt/homebrew/bin/brew update` and `/opt/homebrew/bin/brew upgrade --cask bantou`. Use `/opt/homebrew/bin/brew`, never `/usr/local/bin/brew`.
7. Restart the app: `pgrep -fl 'bantou.app/Contents/MacOS'`, `kill <pid>` (by PID only), `open -a /Applications/bantou.app`. Check `CFBundleShortVersionString` in `/Applications/bantou.app/Contents/Info.plist`.

Network commands (ssh, rsync, curl, cargo build, brew) need the Bash sandbox off.
