# bantou-center.app

窓の無い app。center を子 process として起動して常駐させ（#15 = X）、初回の起動で自分を launchd の agent に登録する（#14 = A）。設計: `docs/design/center-graphql-server.md` の 2.7。

**実機（mac）では未確認**。この repo の host では `cargo check --target aarch64-apple-darwin` までしか通していない。

## 動き

- 起動すると `bantou-center`（同梱の center）を `--transport http --bind 0.0.0.0 --config ~/.local/share/bantou/center-server.json` で起動する。`--port` は渡さない。port・鍵を渡す IP の範囲は config の `port`（既定 7910）・`keyRanges`（`packages/center/README.md`）。config が無ければ `{}` で作る。
- Dock に出ない（`LSUIElement`・accessory）。窓も無い。log は `~/.local/share/bantou/center-app.log`。
- `SMAppService.agent(plistName: "jp.grrow.bantou-center.plist")` で登録する。登録済みなら何もしない。承認待ち・無効（System Settings の Login Items）は強制せず、log に出す。
- plist（`src-tauri/launchd/`）は bundle の `Contents/Library/LaunchAgents/` に入る（`tauri.conf.json` の `bundle.macOS.files`）。`KeepAlive` は `SuccessfulExit: false`: 異常終了だけ launchd が再起動する。
- center が終わると、app は設定の port を別の center が今使っているかを見て終わる。使用中 = 0（譲る。launchd は再起動しない）、空き = 1（launchd が再起動する）。center の終了状態は見ない。
- menu bar に項目が出る（#18 = A）。「止める」は center を止めて app を正常終了（0）する。KeepAlive は `SuccessfulExit: false` なので launchd は再起動しない。
- 「設定の file を開く」は `~/.local/share/bantou/center-server.json` を既定の app で開く（`open`）。設定画面・状態の表示は無い。
- Finder から起動した instance は、launchd に登録できた（登録済みを含む）なら center を起こさず exit 0 し、launchd の instance に任せる。登録済み（enabled）でも launchd に job が実際に在るかを `launchctl print gui/<uid>/<Label>` の成否で確かめ、無ければ `SMAppService.unregister()` → `register()` で載せ直す。launchd の起動かは環境変数 `XPC_SERVICE_NAME` が plist の Label かで見る。登録に失敗した（承認待ち・無効を含む）時と、載せ直しても job が無い時だけ、自分で center を起こす。
- 二重に起動しても何もしない（single-instance）。SIGTERM（launchd の停止）では center を止めてから終わる（最大 15 秒）。

## build

- 同梱する center と pty-wrapper は desktop の `bun run build:sidecar`（`packages/desktop/src-tauri/binaries/`）を使う。`tauri.conf.json` の `externalBin` がそこを指す。
- `cd src-tauri && cargo tauri build`（未確認）。署名は desktop と同じ ad-hoc（`signingIdentity: "-"`）。
