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

## Release / deploy

Do it without asking once the review check passes.

1. Bump the version in `package.json` and `src-tauri/Cargo.toml`. Commit on develop.
2. `git push origin develop`, fast-forward main (`git merge --ff-only develop`), `git push origin main`, back to develop.
3. Build: `CI=true bun run tauri build`. Output: `src-tauri/target/release/bundle/dmg/bantou_<ver>_aarch64.dmg`.
4. Gitea release (basic auth from `git credential fill`, host 192.168.1.202):
   - `POST /gitea/api/v1/repos/agent-hand/bantou/releases` with `{"tag_name":"v<ver>","target_commitish":"main","name":"v<ver>"}`
   - `POST .../releases/<id>/assets?name=bantou_<ver>_aarch64.dmg` with `-F attachment=@<dmg>`
5. Cask: `scripts/publish-cask.sh <ver> $(shasum -a 256 <dmg> | cut -d' ' -f1)`. Then `git pull origin main` on develop.
6. This Mac: `/opt/homebrew/bin/brew update` and `/opt/homebrew/bin/brew upgrade --cask bantou`. Use `/opt/homebrew/bin/brew`, never `/usr/local/bin/brew`.
7. Restart the app: `pgrep -fl 'bantou.app/Contents/MacOS'`, `kill <pid>` (by PID only), `open -a /Applications/bantou.app`. Check `CFBundleShortVersionString` in `/Applications/bantou.app/Contents/Info.plist`.

Network commands (ssh, rsync, curl, cargo build, brew) need the Bash sandbox off.
