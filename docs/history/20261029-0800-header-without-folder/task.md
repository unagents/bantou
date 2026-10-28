# 指示書: フォルダ未選択でも設定と center に届く最初の画面にする

- 日付: 2026-10-29 / 発行: Mac main cap
- 実行: 204 remote cap。worker は sonnet か opus（Fable は使わない）。cargo は `CARGO_BUILD_JOBS=2`・`-j 2`、コマンドは逐次。
- 作業 dir: `/home/vagrant/work/bantou/develop`（branch develop）。前提: `docs/concept.md`。

## ユーザー指摘

- 作業フォルダ未選択の最初の画面は「フォルダを開く」だけで、ヘッダー（設定の歯車、center 状態）が無い。フォルダを開くまで center の設定に届かない。UI として良くない。

## 変更内容

- フォルダ未選択でもヘッダーを常に出す。設定（歯車）と center 状態は常に使える。フォルダに依存するもの（返答待ち、セッション追加、パス表示）はフォルダ選択後だけ出す。
- 本文の空状態は「フォルダを開く」を残す（中央）。迷わない UI（何が出ていて何が出ていないか分かる）。
- e2e: フォルダ未選択で歯車から設定を開ける・center 状態を開ける spec。既存 spec を壊さない。

## 範囲外

- version bump、release、main への push。番頭を最初の窓口にする等の画面構成の再設計はしない（別途ユーザー判断）。

## 報告

- 同 dir に `report.md`。develop に commit・push（push まで必ず）。
