# settings: 保存ボタンを 1 つに統合

基点 develop 1f2ce896e32142ba6fed050da9089f7241adf716 / branch fix/settings-single-save

## 現状分析
- 対象は `SettingsDialog.vue`（ヘッダー歯車）のみ。`ProjectSettingsDialog.vue`（session 歯車）は元から保存 1 つ（名前・フォルダ・追加指示・参照フォルダ）で変更なし。`ProjectSettingsFields.vue` は共有の欄部品で保存を持たない。
- 「共通の設定を保存」(`center-common-save`): 全 session 共通の追加指示/参照フォルダ → 接続中 center の tool `center_settings_update`。dirty は draft と baseline の比較、検証は `draftError`、エラーは節内 `center-common-error` / `-problem`。session 再起動なし。
- 「保存」(`settings-save`): center 設定（enabled/port/bind/token/workspace/claudePath/remote）→ Tauri `center_set_settings`（settings.json 保存 + `Center.apply` = sidecar 起動/停止/再起動、接続先切替）。成功で閉じる。エラーは `settings-error`。
- 分かれていた理由: API が別（center の MCP tool とローカル Tauri コマンド）、保存先 center が別（共通は接続中 center、center 設定は接続先自体を変えうる）、再起動影響が別。
- 未保存で閉じる確認・Enter ハンドラは元から無い（Esc は UModal 既定）。→ 現状維持。

## 仕様の判断
- 順序: 共通 → center 設定。center 設定の保存で接続先が変わりうるため、共通は読み込み元の center へ先に保存する。
- 共通が失敗: center 設定は呼ばず中断（未保存のまま再試行可。接続先ずれを防ぐ）。
- 共通成功 → center 設定が失敗: 共通は巻き戻さず baseline 更新、ダイアログは開いたまま、「center の設定の保存に失敗した（共通の設定は保存済み）」を表示。再試行は center のみ呼ぶ。理由: 2 つは独立した保存先で原子的にできず、保存済みの側を戻すと別の副作用（再度の書き込み）が要る。
- 両方成功時のみ閉じる。変更の無い区分は API を呼ばない。何も変更が無ければ保存は無効。
- session 再起動を伴う項目: 共通設定に再起動は無く、注意書き（INSTRUCTIONS_NOTE）は ProjectSettingsFields に残したまま。center 設定の保存が sidecar 再起動を伴う点は README に追記。
- 見出し「全 session 共通の設定」・「この PC の center」は残した。

## 変更ファイル
- packages/desktop/src/components/SettingsDialog.vue
- packages/desktop/e2e/session-instructions.spec.ts
- packages/desktop/README.md（e2e 専用 README は存在しないため、e2e 記述もこの README の該当箇所）
- docs/history/.../report.md

## テスト結果
- desktop e2e 全件: 129 passed / 0 failed（retries 0、nuxt generate の静的ビルドを簡易 node サーバーで配信、ms-playwright chromium-1243 を自己完結の一時 config で指定）。
- 追加: 共通+center 同時変更で各 API 1 回 / 片方だけなら片方だけ / 共通失敗 / center 失敗（共通保存済み）。
- nuxt typecheck: 実行したが vue-tsc が `vue-router/volar/sfc-route-blocks` を解決できず警告（環境起因）。TS error 0 件・exit 0 だが完全な検証とは言えない。
- cargo test: Rust 無変更のため省略。

## 廃止・変更した testid
- 廃止: `center-common-save`（共通の保存ボタン）
- 継続して使用: `settings-save`（共通+center の保存を兼ねる）。有効条件が「共通 or center 設定のいずれかに変更あり」に変わった。
- `settings-error`: 共通失敗時にも出るようになった（文言は上記）。`center-common-error` は残置。
- toast: 「共通の設定を保存した」は center 失敗時のみ。通常成功は「設定を保存した」。

## 残り
- なし（review 指摘と対応は後で追記）
