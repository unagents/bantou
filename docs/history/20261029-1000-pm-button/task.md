# 指示書: 画面上に PM を立てるボタンを用意し、PM に名前を設定する

- 日付: 2026-10-29 / 発行: Mac main cap
- 実行: 204 remote cap。worker は sonnet か opus（Fable は使わない）。cargo は `CARGO_BUILD_JOBS=2`・`-j 2`、コマンドは逐次。
- 作業 dir: `/home/vagrant/work/bantou/develop`（branch develop）。前提: `docs/concept.md`。

## 目的（ユーザー）

- 画面上に PM を立てるボタンを用意。PM には名前を設定。

## 変更内容

1. desktop のヘッダー（フォルダ未選択でも出る位置）に「PM を立てる」ボタンを置く。
2. 押すと名前入力（英数字と `_` `-`、既存名と重複不可）→ center の `session_create`（desktop の MCP client 経由）で master-cap を起動。
3. 結果（成功: sessionUrl、失敗: 理由）を表示。
4. 立てた PM の一覧（`session_list`、名前・状態・sessionUrl）も見られるようにする。削除ボタンは今回不要。
5. center が off で接続先も無い時はボタンを無効にし、理由を出す。
6. e2e mock と spec、README を合わせる。

## 報告

- 同 dir に `report.md`。develop に commit・push（push まで必ず）。
