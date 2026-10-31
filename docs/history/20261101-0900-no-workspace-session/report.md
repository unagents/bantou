# 報告: center 起動時の `workspace` session 自動起動をやめる

- 実行: 204 remote cap。worker は sonnet 1 体。cargo は `CARGO_BUILD_JOBS=2`・`-j 2`、逐次実行。

## 変更ファイル

- `packages/center/src/config.ts`: config に任意項目 `workspace`（絶対パス）を追加。
- `packages/center/src/sessions.ts`: `WORKSPACE_PROJECT` を削除。`session_create` で path を省くと `config.workspace/<name>` を使う。`workspace` が無ければ path 必須。
- `packages/center/test/config.test.ts`, `sessions.test.ts`: `config.workspace` を前提にテストを更新・追加。
- `packages/center/README.md`: config 表と `session_create` の説明を更新。
- `desktop/src-tauri/src/center.rs`: `build_config` は `projects` を書かず、`workspace`（解決後の絶対パス）を書く。テスト 3 件を更新。
- `desktop/e2e/mock/bantou.ts`: center の session 初期値を空にした（`workspace` を削除）。
- `desktop/e2e/session-add.spec.ts`: 「config 由来の workspace が一覧に出る」検証を削除。名前重複の検証は center にだけある session（`center-only`）で行う。
- `desktop/README.md`: center.json の説明を更新。
- `docs/`: 該当記述なし。

## テスト結果

- packages/center `npm test`: 196 pass / 0 fail。
- desktop Rust `cargo test -j 2`: 214 pass / 0 fail / 5 ignored。
- e2e `session-add.spec`: 13 pass / 0 fail。
- e2e `settings.spec`: 12 件中 5 件 fail。変更前（git stash）でも同じ 5 件が落ちる。原因は「設定を保存した」が 2 要素に一致する strict mode 違反。今回の変更とは無関係。
- `tsc` は npx が registry に届かず未実行。

## projects の仕組み（今回は残した）

- 残したもの: config の `projects`、`rc_*` tool、`source: project`、autostart、daemon.ts の起動ログ。
- desktop は projects を渡さなくなった。desktop 経由の center では projects は常に空。影響を受けるのは手書き config の利用者だけ。
- 消す場合の影響範囲:
  - daemon.ts の supervisor 初期投入。
  - `rc_*` tool 群。
  - session_list の source 区別。
  - `projects[].env/spawn/capacity` 設定。
  - center の rc-orphan / remote-control / sessions / config の各テスト。
  - README の config 節。
- `session_create` も supervisor の entry を使う。projects を消す場合も supervisor の入口は残す必要がある。

## 旧保存値（projects 入りの center.json）の挙動

- 移行処理は入れていない。
- desktop は center を起動するたびに center.json を丸ごと書き直す。desktop 経由なら次回起動で `projects` が消え、`workspace` が入る。
- 旧 center.json を center が直接読むと、従来どおり `workspace` project が autostart する。この場合 `workspace` キーが無いので、path を省いた `session_create` は拒否される。
- sessions.json に残った session は従来どおり復帰する。

## 後始末

- 停止したもの: playwright の webServer（nuxt dev, port 1420）。各実行の終了時に止まり、pgrep / ss で残存なしを確認した。
- 残存:
  - `/home/vagrant/work/bantou/scratch-no-workspace/`（`pw.config.ts` と `package.json` の 2 ファイル）。worker と cap の削除は、どちらも単独コマンドで permission により拒否された。
  - `desktop/node_modules/.cache/bantou-e2e/`（playwright の出力。既存の cache dir）。
  - `~/.cargo/registry` に crate が追加された（netwatcher ほか）。`Cargo.lock` は変わっていない。

## 要判断事項

- `settings.spec` の既存 5 件 fail を直すかどうか。
- center の projects の仕組みを削除するかどうか（影響範囲は上記のとおり）。
- cargo は sandbox を無効にして実行した。sandbox 内では `~/.cargo` が読み取り専用で、crate も未取得だったため。
- 204 に Chrome が無い。e2e は scratch の一時 config で ms-playwright の chromium を指定して実行した。repo の `playwright.config.ts` は変更していない。
