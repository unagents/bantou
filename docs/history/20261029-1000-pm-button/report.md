# 報告: 画面上に PM を立てるボタンを用意し、PM に名前を設定する

- 日付: 2026-10-29 / 実行: 204 remote cap（worker: sonnet 1 本。Fable 不使用）
- 区分: 【概念】= `docs/concept.md` の原則に関わる判断、【今は】= いずれ変わり得る実装判断

## 変更（desktop のみ）

- `AppHeader.vue`: 「PM を立てる」ボタン（フォルダ未選択でも表示、`data-testid=open-pm`）。
- `PmDialog.vue`（新規）: 名前入力 → center の `session_create`（`{name}`）を既存の `center_call` 経由で呼ぶ。成功は名前と sessionUrl（未取得なら state）、失敗は center の理由を表示。
- 同ダイアログに `session_list` のうち `source: session`（session_create で作ったもの）を名前・状態・sessionUrl で一覧。削除ボタンなし。
- 名前検証: 英数字と `_` `-` のみ。`session_list` の全名（config 由来を含む）と重複不可。center 側のエラーもそのまま表示。
- 無効判定: 保存済み center 設定が `enabled=false` かつ remote 接続先なし（Rust `select_target` と同じ規則）の時、ボタン無効と理由表示。
- `e2e/mock/bantou.ts`（`session_list` / `session_create`）、`e2e/pm.spec.ts`（新規）、`desktop/README.md`、`src/types/index.ts`（`CenterSession`）。
- center・Rust は変更なし（cargo 未実行）。center の `session_create` / `session_list` の入出力は現行コードで一次確認済み。

## 判断

| 判断 | 区分 | 理由 |
|---|---|---|
| PM を立てる窓口は desktop、起動と管理は center | 概念 | 原則 3・登場者（center が master-cap の起動と管理を持つ）。既存の構成のまま |
| 起動手段は center の `session_create`（`claude remote-control`） | 今は | concept.md「今は」の起動手段 |
| 無効判定の再評価は読み込み時と設定ダイアログ close 時のみ | 今は | 設定変更の経路がそこだけのため。自動ポーリングはしない |
| PM 一覧は開いた時・作成後・更新ボタンで取得（自動更新なし） | 今は | 指示に自動更新の要求が無いため |

## 証跡

- `bun run typecheck`: exit 0（`vue-router/volar` の警告のみ、変更前から）。
- `e2e/pm.spec.ts`: 8 passed（成功・URL 未取得・失敗・重複名・不正名・無効状態と復帰・center 不応答・フォルダ未選択）。
- e2e 全体（`pw-local.config.ts`、chromium-1243、`--retries=0`、sandbox off）: 37 passed / 3 failed。failed は既知の `settings.spec.ts` 3 件のみ。

## 未検証

- 実 center（実 Tauri / Rust 経由）での `session_create`。mock のみ。
- 実機 UI の見た目（狭いヘッダーでの無効理由テキスト）。

## 後始末

- nuxt / chrome プロセス無し、port 1420 解放を確認。
- 削除が permission で拒否され残存: `/tmp/claude-1002/pm.log`、`all.log`、`tc.log`。
