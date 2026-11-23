# bantou-center.app

窓の無い app。center を子 process として起動して常駐させ（#15 = X）、初回の起動で自分を launchd の agent に登録する（#14 = A）。設計: `docs/design/center-graphql-server.md` の 2.7。

**実機（mac）では未確認**。この repo の host では `cargo check --target aarch64-apple-darwin` までしか通していない。

## 動き

- 起動すると `bantou-center`（同梱の center）を `--transport http --bind 0.0.0.0 --config ~/.local/share/bantou/center-server.json` で起動する。`--port` は渡さない。port・鍵を渡す IP の範囲は config の `port`（既定 7910）・`keyRanges`（`packages/center/README.md`）。config が無ければ `{}` で作る。
- Dock に出ない（`LSUIElement`・accessory）。窓も無い。log は `~/.local/share/bantou/center-app.log`。
- `SMAppService.agent(plistName: "jp.grrow.bantou-center.plist")` で登録する。登録済みなら何もしない。承認待ち・無効（System Settings の Login Items）は強制せず、log に出す。
- plist（`src-tauri/launchd/`）は bundle の `Contents/Library/LaunchAgents/` に入る（`tauri.conf.json` の `bundle.macOS.files`）。`KeepAlive` は `SuccessfulExit: false`: 異常終了だけ launchd が再起動する。
- center が終わると app も同じ状態で終わる（正常終了 = 0、それ以外 = 1）。port が使用中で center が正常終了した時に、再起動し続けない。
- 二重に起動しても何もしない（single-instance）。SIGTERM（launchd の停止）では center を止めてから終わる（最大 15 秒）。

## build

- 同梱する center と pty-wrapper は desktop の `bun run build:sidecar`（`packages/desktop/src-tauri/binaries/`）を使う。`tauri.conf.json` の `externalBin` がそこを指す。
- `cd src-tauri && cargo tauri build`（未確認）。署名は desktop と同じ ad-hoc（`signingIdentity: "-"`）。
