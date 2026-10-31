# 追加指示 2: セッション一覧の修正だけを別 worktree で先に出す

- 日付: 2026-11-01 / 発行: Mac main cap

## ユーザー指示

追加指示 1（desktop のセッション一覧を center の `session_list` そのものにする）のうち、今の構成で出せる部分を、別の worktree で並行して先に仕上げる。Mac main cap が mac200 で E2E を通して 0.1.24 として出す。

## やり方

- `origin/develop` から branch `fix/session-list-from-center` を切り、worktree `/home/vagrant/work/bantou/wt-session-list` で作業する。worker を 1 体追加して並行で進める（sonnet）。
- 範囲（desktop のみ）:
  - サイドメニューの一覧を、つないでいる center の `session_list` そのものにする。desktop のメモリの「追加済み」一覧（`session.rs` の `Sessions`、`add_sessions`、`reconcile` の lost 判定）はやめる。
  - 取り直しは今の時機（操作前・スリープ復帰・ネットワーク変化・設定を閉じた時・5 分）のまま。core のイベントによる即時反映は含めない（大きい実装の方に残す）。
  - center に問い合わせられない時は、最後に取れた一覧を「つながらない」表示付きで出す。
  - 「セッション追加」は新規作成（`session_create`）だけにする。一覧から選んで追加する画面はやめる。
  - 「タスク追加を指示」ボタンは今回は触らない。
  - Rust テストと e2e（mock・spec）を合わせる。
- 完了したら branch を push する（develop には入れない）。report は同 dir に `report-add-2.md`。
- w-desktop からは「一覧の取り方」を外す。w-desktop は、この branch が develop に入った後、その上に合わせる。

## 範囲外

- version bump、release、main への push、develop への merge（Mac main cap が行う）。
