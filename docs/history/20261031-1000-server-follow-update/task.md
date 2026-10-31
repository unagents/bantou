# 指示書: desktop の更新に合わせて server を揃える

- 日付: 2026-10-31 / 発行: Mac main cap
- 実行: 204 remote cap。worker は sonnet か opus（Fable は使わない）。cargo は `CARGO_BUILD_JOBS=2`・`-j 2`、コマンドは逐次。
- 作業 dir: `/home/vagrant/work/bantou/develop`（branch develop）。前提: `docs/concept.md`。

## 目的（ユーザー）

desktop を更新したら、center と server も不都合なく揃うようにする。center は desktop に同梱なので既に揃う。server（別ホストの `npx bantou@<版>`）を揃える仕組みを作る。

## 確定事項

1. desktop のビルドに、組になる server の版（npm `bantou` の版）と protocol `bantou` の版を書き込む（center が参照できる形）。
2. 更新後に起動した center が、見つかった server の版を確かめる。違えば protocol `bantou` で server に「この版に更新せよ」を送る（新メッセージ、protocol の version を上げる）。
3. server は自分で新しい版を取り（`npx -y bantou@<版>`）、同じ config で自分を起動し直す。二重起動しないこと。
4. 起動し直す時期はユーザー確定の A: 動いている cap と worker が全部終わるのを待ってから。待っている間は新しい指示を受け付けず、理由付きのエラーを返す（center は再送できる形）。
5. 版が揃うまで、center は protocol の版が合わない server に指示を送らない。center の状態（desktop の center 状態画面）に「更新中」「版違い」を出す。

## 範囲外

- desktop を agent-messenger 経由で更新させる仕組み（未決）。
- version bump、release、main への push、npm publish。agent-messenger 側の変更。

## 確認

- server・center・protocol・desktop のテスト。
- 204 で隔離 broker を使い、古い版の server（ローカル build）に center から更新指示 → 実行中 cap があれば待つ → 終わったら新しい版で起動し直す、を確かめる（npm 未公開の版は、ローカルの tarball や path を指定できる仕組みでテストしてよい。本番の既定は npm）。終わったら止めて後始末。

## 報告

- 同 dir に `report.md`。判断は「概念」か「今は」の実装かを分けて書く。develop に commit・push（push まで必ず）。
