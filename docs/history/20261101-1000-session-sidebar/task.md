# 指示書: セッション一覧を左のサイドメニューに出す

- 日付: 2026-11-01 / 発行: Mac main cap
- 実行: 204 remote cap。worker は sonnet（Fable は使わない）。cargo は `CARGO_BUILD_JOBS=2`・`-j 2`、コマンドは逐次。
- 作業 dir: `/home/vagrant/work/bantou/develop`（branch develop）。
- 着手条件: `20261101-0900-no-workspace-session` の commit・push 完了後に着手する（並行しない）。

## ユーザー指示

追加したセッションの一覧を、左にサイドメニューを用意して一覧で確認できるようにする。サイドメニューでセッションを選ぶと、右には選んだセッションのタスクだけを出す（ユーザー選択 A）。

## 変更内容

- `desktop/src/pages/index.vue` の本体を「左: セッション一覧のサイドメニュー / 右: 選んだセッション」の 2 ペインにする。今は全セッションの `SessionColumn` を縦に並べている。
- サイドメニューの 1 行: セッション名、ロスト / つながらないの表示（今 `SessionColumn` の見出しにあるものと同じ意味）、進行中 / 待機中の件数。
- 右ペイン: 選んだセッション 1 つの `SessionColumn`（タスク一覧・タスク追加指示ボタンは今のまま）。
- 選択はメモリだけに持つ（保存しない）。未選択、または選んでいたセッションが一覧から消えた時は先頭を選ぶ。
- セッションが 0 件の時は今の空表示（「セッション追加」ボタン付き）を右に出す。
- サイドメニューに指示の無い機能（追加・削除ボタン等）は足さない。
- e2e（mock と spec）を合わせる。スクリーンショット（`board.png` 等）にサイドメニューが写ること。README に画面説明があれば合わせる。

## 範囲外

- version bump、release、main への push。

## 報告

- 同 dir `docs/history/20261101-1000-session-sidebar/` に `report.md`（変更ファイル、テスト結果の件数、後始末の結果と残存物、要判断事項）。develop に commit・push（push まで必ず）。
