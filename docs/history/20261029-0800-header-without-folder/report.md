# 報告: フォルダ未選択でも設定と center に届く最初の画面にする

- 日付: 2026-10-28 / 実行: 204 remote cap（worker: sonnet）

## 変更

- `desktop/src/pages/index.vue`: `AppHeader` を `v-if="loaded"` で常時表示。空状態の高さは `min-h-[calc(100vh-var(--cork-header-height))]`。本文中央の「フォルダを開く」は維持。
- `desktop/src/components/AppHeader.vue`: `workspacePath` を `string | null` に変更。パス表示・messenger 状態・セッション追加は `v-if="workspacePath"`。返答待ちバッジは既存の `waitingCount > 0` で未選択時は出ない。
- 歯車・center・フォルダを開くアイコンは常時表示。
- 判断: messenger 状態ドットも未選択時は非表示（broker 接続はフォルダ選択後のため、出すと「探索中」と誤表示する）。

## e2e

- 追加 `desktop/e2e/no-folder.spec.ts`（seed `dir: null`）3 本:
  - the header stays with settings and center, and only the folder items are hidden
  - the gear opens the settings dialog
  - the center status can be opened

## 証跡

- `bun run typecheck`（desktop/）: exit 0、error なし（`vue-router/volar` の plugin 解決 warning のみ、変更前と同じ）。
- desktop に lint・単体テストの script は無い。
- 規定 e2e は実行不可:
  - mac200: `ssh claude-cli@192.168.1.200 true` が `Network is unreachable`。
  - 204: `bun run e2e` が `Chromium distribution 'chrome' is not found at /opt/google/chrome/chrome`。
- 代替: playwright cache の chromium-1243 を使う使い捨て config で全 spec 実行（`--retries=0`）: 26 passed / 3 failed。新規 3 本は全 passed。
- failed 3 件は `settings.spec.ts` :3 / :51 / :85。`getByText('設定を保存した')` が toast と aria-live の 2 要素に解決し strict mode violation。変更を stash した baseline でも同じ 3 件が落ちるため今回の変更とは無関係。

## 未検証

- mac200 の system Chrome での e2e。
- 実機 Tauri での見た目（ドラッグ領域、`pl-20` の余白）、スクリーンショット目視。
- `cargo test`（Rust 変更なしのため未実施）。

## 範囲外で気づいた点

- 未選択時、ヘッダーの「フォルダを開く」アイコンと本文の「フォルダを開く」ボタンが並ぶ（そのまま）。
- `settings.spec.ts` の既存 3 件 failure（上記、既存不具合）。

## 後始末

- 使い捨て `desktop/pw-local.config.ts` は worker の `rm` が permission で拒否され残存。commit には含めていない（未追跡のまま）。
