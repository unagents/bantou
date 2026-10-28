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

Do it without asking once the review check passes.

1. Bump the version in `package.json`, `src-tauri/Cargo.toml` and `Cargo.lock`. Commit on develop. Do not edit `Casks/bantou.rb` by hand; step 5 rewrites it.
2. Push to GitHub (`origin`; Gitea `gitea` is a read-only pull mirror, never push there): `git push origin develop`, fast-forward main (`git merge --ff-only develop`), `git push origin main`, back to develop.
3. Build (in `desktop/`). The updater artifacts are signed at build time with the key on this Mac (`~/.tauri/bantou-updater.key`, no password; never copy it elsewhere):
   `TAURI_SIGNING_PRIVATE_KEY="$(cat ~/.tauri/bantou-updater.key)" TAURI_SIGNING_PRIVATE_KEY_PASSWORD="" CI=true bun run tauri build`
   `beforeBuildCommand` runs `bun run build:sidecar && bun run generate`. Output under `src-tauri/target/release/bundle/`: `dmg/bantou_<ver>_aarch64.dmg`, `macos/bantou.app.tar.gz`, `macos/bantou.app.tar.gz.sig`.
   Generate the updater manifest: `scripts/make-latest-json.sh <ver> src-tauri/target/release/bundle/macos/bantou.app.tar.gz.sig latest.json` (platform `darwin-aarch64`; needs `jq`).
4. GitHub release: `gh release create v<ver> <dmg> src-tauri/target/release/bundle/macos/bantou.app.tar.gz src-tauri/target/release/bundle/macos/bantou.app.tar.gz.sig latest.json --title v<ver> --notes ""`. The installed app checks `releases/latest/download/latest.json`, so attach all three updater files.
5. Cask (in `desktop/`): `scripts/publish-cask.sh [--dry-run] [--force] <ver> $(shasum -a 256 <dmg> | cut -d' ' -f1)`. Needs authenticated `gh` and `jq`; no env vars.
   Rewrites `version`/`sha256` in `desktop/Casks/bantou.rb` (commit the result) and updates `Casks/bantou.rb` in GitHub `unagents/homebrew-tap` via API.
   It aborts when the tap file differs by more than version/sha256. Use `--force` only when `Casks/bantou.rb` itself changed (lines added or removed); check the printed diff.
6. This Mac (tap `unagents/tap`): `/opt/homebrew/bin/brew update` and `/opt/homebrew/bin/brew upgrade --cask bantou`. Use `/opt/homebrew/bin/brew`, never `/usr/local/bin/brew`.
7. Restart the app: `pgrep -fl 'bantou.app/Contents/MacOS'`, `kill <pid>` (by PID only), `open -a /Applications/bantou.app`. Check `CFBundleShortVersionString` in `/Applications/bantou.app/Contents/Info.plist`.

Network commands (ssh, rsync, curl, cargo build, brew) need the Bash sandbox off.
