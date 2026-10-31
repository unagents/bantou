# 指示書: center の接続先 IP を外側 IP 既定にする / 待ち受けを 0.0.0.0 に / IP 変化の検知

- 日付: 2026-10-31 / 発行: Mac main cap（204 remote cap が整形）
- 実行: 204 remote cap。worker は sonnet（Fable は使わない）。cargo は `CARGO_BUILD_JOBS=2`・`-j 2`、コマンドは逐次。
- 作業 dir: `/home/vagrant/work/bantou/develop`（branch develop）。

## ユーザー指示（原文）

1. 「center 有効時の MCP 接続設定の出力が既定で localhost(127.0.0.1) になっている。これだとリモートの desktop が接続するのに center 側でいちいち変更が要る。MCP サーバーは外に公開されるものだから、そのマシンの外側 IP を選ぶのを前提にせよ」
2. 「設定を開いた際に IP アドレスの有効性や変更を検知し、変わっている場合はその状態を報告し、前と同じでいくか新しい IP でいくかを選ばせたい」

## 確定事項（main cap 回答込み）

### A. 待ち受けと IP 選択の意味
- center の待ち受けは常に全アドレス（`0.0.0.0`）。LAN からも Tailscale からも届くようにする。守りは token。
- IP の選択は bind ではなく、接続設定（MCP 接続設定の出力）の URL のホストを決めるだけにする。
- 前回の「bind と IP 選択の統合」は、選択の UI は 1 つのまま、意味を「URL のホスト」に変える。設定の bind 項目の表示・説明もこれに合わせる。

### B. 既定値
- 保存値が無い時: 自ホストの外側 IP（loopback 以外の IPv4 の先頭。LAN を優先）。
- 外側 IP が 1 つも無い時だけ `127.0.0.1`。
- `127.0.0.1` は一覧に残し、選べば使える。
- 前回 main cap が入れた「保存値が一覧に無い時の 127.0.0.1 フォールバック」は撤回。
- 保存値があって一覧に無い時は、自動で切り替えない（C の表示でユーザーが選ぶまで保存値のまま）。
- 既存の保存値を書き換える移行処理は入れない。

### C. IP 変化の検知（設定画面）
- 設定画面を開いた時、保存済みの IP を今の自ホストの IP 一覧と照合する。
- 一覧にある場合は何も出さない。
- 一覧に無い場合は画面上部に状態を出す（例: 「保存の IP 192.168.1.50 は今このマシンに無い。今の候補: …」）。
- 選択肢は「前と同じ IP のまま」と「新しい IP にする（候補から選ぶ。既定は外側 IP の先頭）」。
- 選ぶまで勝手に変えない。新しい IP を選んで保存したら、center と接続設定に反映する。
- center 起動時に bind（待ち受け）できなかった場合も、同じ状態表示につなげる。

## 合わせる範囲

- Rust（desktop/src-tauri）、UI（desktop/src）、e2e の mock と spec、README（desktop/README.md と、関係する docs があれば）。
- e2e spec に追加: IP が消えた状態で設定を開く → 状態表示 → 「前と同じ」を選んだ結果 / 「新しい IP」を選んだ結果。保存値無しで外側 IP が既定になること。

## 確認

- `cargo test`（並列を絞る）、typecheck（環境で動かなければ report に）。e2e 実行は mac200 で main cap が行う（spec と mock は書く）。

## 範囲外

- version bump、release、main への push。bun.lock の opener 残り（main cap が揃える）。

## 報告

- 同 dir に `report.md`。後始末は自分で行い、残ったものを列挙。develop に commit・push（push まで必ず）。
