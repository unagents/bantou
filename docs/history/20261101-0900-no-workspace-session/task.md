# 指示書: center 起動時の `workspace` session の自動起動をやめる

- 日付: 2026-11-01 / 発行: Mac main cap
- 実行: 204 remote cap。worker は sonnet（Fable は使わない）。cargo は `CARGO_BUILD_JOBS=2`・`-j 2`、コマンドは逐次。
- 作業 dir: `/home/vagrant/work/bantou/develop`（branch develop）。

## ユーザー指示

desktop が center の設定に project `{name: "workspace", path: <workspace>, autostart: true}` を書き出し、center が起動時に `claude remote-control --name workspace` を自動で立ち上げている。これが「セッション追加」の候補に `workspace` として出て意味が分からない。やめる。

## 変更内容

- center の起動で session を自動で立てない。session は「セッション追加」（`session_create`）で作るものだけにする。
- desktop は center の設定（`center.json`）に project を書かない。workspace のパスは、`session_create` で path を省いた時の置き場所（`<workspace>/<name>`）としてだけ center に渡す（center の config に workspace 用の項目を足す等。packages/center の変更可。今 center が projects から workspace を拾っている箇所を直す）。
- center の projects の仕組み自体（config の `projects`、`rc_*` tool、`source: project`）を残すか消すかは、影響範囲を調べて report に書く。今回は「desktop から project を渡さない」ことと「workspace をパスとして渡す」ことだけ行い、仕組みの削除はしない。
- 既存の保存値を書き換える移行処理は入れない。
- テスト（center、Rust、e2e mock と spec）と README を合わせる。

## 範囲外

- version bump、release、main への push。

## 報告

- 同 dir `docs/history/20261101-0900-no-workspace-session/` に `report.md`。後始末は自分で行い、残ったものを列挙。develop に commit・push（push まで必ず）。
