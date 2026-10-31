# 報告: 追加指示 2（セッション一覧を center の session_list そのものにする）

- 日付: 2026-11-01 / 実行: 204 remote cap（worker は sonnet）
- branch: `fix/session-list-from-center`（`origin/develop` 1b4d1f4 から）。commit 7874b50（実装）と本報告の commit。develop には入れていない。

## 変更（desktop のみ）

- サイドメニューの一覧は、つないでいる center の `session_list` をそのまま出す。
- desktop のメモリの「追加済み」一覧はやめた（`session.rs` の `Sessions`・`add_sessions`・`unregister_session`・`reconcile`・`Link`・`CenterEntry` を削除）。
- 最後に取れた一覧だけを `SessionCache` に持つ。取れない時は前の一覧を残し、`reachable=false` にする（純関数 `apply_listing`）。
- center に問い合わせられない時は、サイドメニュー上部に「つながらない」バッジ（`side-unreachable`）を 1 つ出す。行ごとの「ロスト」表示は削除した。
- 取り直しの時機は従来どおり（操作前・スリープ復帰・ネットワーク変化・設定を閉じた時・5 分）。`refresh_sessions` は常に center へ問い合わせる。`create_session` は作成後に取り直す。center のイベントによる即時反映は含めていない。
- 「セッション追加」は `session_create` だけにした（`AddSessionDialog.vue` を作り直し、一覧から選ぶ UI を削除）。
- 「タスク追加を指示」ボタンと `instruct_add_task` は触っていない。
- 他の変更箇所: `types/index.ts`、`api/sessions.ts`、`api/index.ts`、`composables/useBoard.ts`、`pages/index.vue`、`components/SessionColumn.vue`、`desktop/README.md`（セッション追加の節）。
- e2e: mock の `added`・`add_sessions`・`unregister_session` を削除した。`session-add.spec.ts` の「一覧から選んで追加」「ロスト」系 5 件を、新しい 4 件に置き換えた。
  - 他所で作られたセッションが出る・消える
  - 作成のみ
  - つながらない時は最後の一覧を残す
  - つながらない状態から回復したら「つながらない」表示が消える

## テスト結果

| | 前 | 後 |
|---|---|---|
| desktop `cargo test` | 214 passed / 5 ignored | 211 passed / 5 ignored（旧 session テスト 10 件を新 7 件に置換。cap が再実行して確認） |
| e2e | 57 passed | 56 passed / 0 failed（旧 5 件 → 新 4 件） |

- e2e は 204 の sandbox では通常の手順で回せなかった。
  - sandbox が unix socket の listen を EPERM で拒否するため、`nuxt dev` が起動しない。
  - 代わりに `bun run generate` の静的ビルドを node の簡易静的サーバー（ポート 1460）で配信した。ブラウザは chromium headless shell を一時 config で指定した。
  - 通常の `playwright.config.ts` での e2e は mac200 で未実施。

## 要判断事項

1. center が OFF で、貼った接続先も無い時は、一覧が空のまま「つながらない」バッジが出る。以前は問い合わせず何も出さなかった。「接続先なし」を別の表示にするかは未判断。
2. `session_list` の全件を出し、`source`（config / session）では絞っていない。
3. 作成後の取り直しは Rust の `create_session` の中で行う。ダイアログからは呼ばない。
4. 指示書の worktree パス `/home/vagrant/work/bantou/wt-session-list` には作れなかった。
   - sandbox が書込を拒否し、解除しての実行は auto mode の分類器に拒否された。
   - 代わりに `develop/.claude/worktrees/` の下の隔離 worktree で同じ branch を使った。
   - `.git/config` に書けないため、upstream は設定していない。

## 後始末

- 起動したサーバー（静的サーバー・nuxt dev）は停止済み。
- 以下は `rm` が権限で拒否され、残っている。
  - worktree の `desktop/pw.local.config.ts`（未追跡）
  - `/tmp/claude-1002/w-sl/`
- worktree の `desktop/src-tauri/binaries/` には `bantou-center-*` を develop からコピーした。gitignore の対象なので commit には入らない。
