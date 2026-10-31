# Report: updater 後始末

## 変更ファイル（desktop/）
- README.md: アップデート節のトースト説明をヘッダー更新ボタン（cmux 方式）の説明に置換
- src/composables/useUpdater.ts: `dismiss()` と古いコメントを削除、return から除去
- src/api/updater.ts: `openReleaseNotes` と opener import を削除
- src/api/index.ts: `openReleaseNotes` の re-export を削除
- package.json: `@tauri-apps/plugin-opener` を削除
- src-tauri/Cargo.toml: `tauri-plugin-opener` を削除
- src-tauri/Cargo.lock: cargo test で再生成（opener 関連 23 行削除、残 0）
- src-tauri/src/lib.rs: `.plugin(tauri_plugin_opener::init())` を削除
- src-tauri/capabilities/default.json: `opener:default` を削除

## opener grep
- 対象: node_modules / target / .git / .nuxt / .output / docs/history 除外で `opener|openUrl|openPath|openReleaseNotes|dismiss`
- 他の使用箇所なし（updater.ts の openUrl のみ）。`dismiss` も useUpdater.ts 内のみ。e2e にも参照なし。

## cargo test
- `CARGO_BUILD_JOBS=2 cargo test -j 2 --offline`: 207 passed; 0 failed; 5 ignored

## typecheck
- `bun run typecheck` は環境エラーで実行不可: `[Vue] Resolve plugin path failed: vue-router/volar/sfc-route-blocks Error: Cannot find module 'vue-router/volar/sfc-route-blocks'`（前回 report と同じ、変更起因ではない）

## 未実施・残り
- **bun.lock（リポジトリ root にある）は未更新**。`plugin-opener` が 17 行目と 465 行目に残る。
  - `bun install` はサンドボックスで tempdir EROFS、`BUN_TMPDIR` 指定後はネットワーク（registry.npmjs.org）遮断で resolve 失敗。
  - ネットワーク許可付き再実行と、bun.lock の手編集（該当 2 行削除）は、どちらも実行許可が拒否された。
  - 方針（main cap 回答）: lock はこのまま push し、main cap が後で揃える。
- commit / push は remote cap が実施。e2e は未実施（mac200 で main cap）。
- 後始末: 起動プロセスなし。$TMPDIR の一時物は作成していない（bun cache 用ディレクトリは削除済み/未作成）。
