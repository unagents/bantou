# settings-show-remote 報告

## 変更ファイル
- desktop/src/components/SettingsDialog.vue: `showSavedRemote` 追加。load() で center 無効かつ settings.remote ありの時、貼り付け欄に mcp.json 形式（url、Authorization Bearer token）を入れ、解析結果も出す。settings.remote は触らないので保存済みと同値なら保存は押せない。貼り付け欄の編集は従来の onPaste で解析し直す。
- desktop/e2e/settings.spec.ts: 保存済み接続先が開いた時に出るテストを1件追加（貼り付け欄の内容、解析結果、保存不可、書き換えで再解析・保存可）。mock は変更なし（`center.remote` を既存 mock が返す）。

## テスト
- settings.spec.ts: 16 件 pass（追加1件含む）
- e2e 全体: 70 件 pass、fail 0
- 実行: `bun run generate` の静的ビルドを node の簡易静的サーバー（127.0.0.1:14200）で配信、ms-playwright chromium-1243 を一時 config で指定

## 後始末
- 簡易サーバー停止、port 14200 解放を確認
- bun install が書き換えた bun.lock は git checkout で戻した（commit 外）
- 残存物: `bantou/desktop/playwright.tmp.config.ts`（未追跡、commit 対象外）と `/tmp/e2e-srv.9WsR/`（serve.mjs, srv.log, pid）。rm が permission で拒否されたため削除できていない。
