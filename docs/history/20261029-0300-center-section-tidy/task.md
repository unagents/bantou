# 指示書: center 欄の整理（on/off で出し分け、bind と IP 選択の統合）

- 日付: 2026-10-29 / 発行: Mac main cap
- 実行: 204 remote cap。worker は sonnet か opus（Fable は使わない）。cargo は `CARGO_BUILD_JOBS=2`・`-j 2`、コマンドは逐次。
- 作業 dir: `/home/vagrant/work/bantou/develop`（branch develop）。

## ユーザー指示

1. center を on にしたら、「別ホストの center に接続（貼り付け）」欄は表示しない。
   - off の時: 貼り付け接続欄を出す（この PC は center を持たず、別ホストの center につなぐ）。
   - on の時: 同じ場所に、この PC の center の token・コピペ用接続設定を出す（Cork 同様）。両者を同時に出さない。
2. IP の選択と bind を 2 箇所にばらつかせない。1 つの選択に統合する。
   - 選択肢は自ホストの IP 一覧（前回の列挙: LAN 等の IPv4、`127.0.0.1`、IPv6）。
   - 選んだ IP が center の bind であり、接続設定の URL のホストでもある。bind の自由入力欄と別の「接続先 IP」欄は廃止。
   - 保存済みの bind / connectHost からの移行（一覧にあればそれ、無ければ先頭）は判断して report に。

## 変更内容

- desktop UI（`SettingsDialog.vue`）、Rust（`center.rs` / `center_snippet.rs` の bind・host の扱い）、e2e mock と spec（on/off の出し分け、統合した選択で bind と接続設定が変わる）、`desktop/README.md`。

## 範囲外

- version bump、release、main への push。center（packages/center）・server の変更。

## 報告

- 同 dir に `report.md`。develop に commit・push（push まで必ず行う）。
