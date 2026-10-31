# 指示書: server の入れ替え管理（supervisor）自身も更新されるようにする

- 日付: 2026-10-31 / 発行: Mac main cap
- 実行: 204 remote cap。worker は sonnet か opus（Fable は使わない）。cargo は `CARGO_BUILD_JOBS=2`・`-j 2`、コマンドは逐次（204 は高負荷で固まった前歴あり）。
- 作業 dir: `/home/vagrant/work/bantou/develop`（branch develop）。前提: `docs/concept.md`、前回 `docs/history/20261031-1000-server-follow-update/report.md`。

## ユーザー指示

server の入れ替え管理（`server/bin/supervisor.mjs`）も更新に対応させる。今は supervisor が最初に起動した版のコードのまま残り、supervisor を変えた版を出すと手で起動し直す必要がある。これを無くす。

## 要件

- center からの更新指示で新しい版に入れ替わる時、supervisor も新しい版のものに替わる。
- 既存の取り決めは保つ: 実行中の cap / worker が全部終わるまで待つ（ユーザー確定 A）、二重起動しない（workspace lock）、新しい版が起動しなければ直前の版に戻す、同じ config で起動し直す。
- 外から見た常駐の形（`npx bantou@<版> --config ...` を 1 回起動すれば以後は自分で更新し続ける）を保つ。
- 0.3.0 の supervisor からこの新しい仕組みへの移行は、もう一度だけ手で起動し直すことで良い（report に明記）。以後は手作業が要らないこと。
- 方式（supervisor が新版の supervisor に引き継いで自分は終わる、変わらない最小の launcher を置く等）は任せる。判断は「概念」か「今は」かを分けて report に。

## 確認

- server のテスト。204 の隔離 E2E で、supervisor のコードが違う 2 つの版（tarball、`update.spec` を利用）の間で、更新後に supervisor の PID / 版が新しいものになること、巻き戻し、二重起動なしを確かめる。終わったら止めて後始末。

## 範囲外

- version bump、release、main への push、npm publish。

## 報告

- 同 dir に `report.md`。作業で起動したプロセスと一時物は必ず自分で後始末し、残ったものは report に列挙。develop に commit・push（push まで必ず）。
