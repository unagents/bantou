# 指示書: 接続設定の IP を自ホストの IP 一覧から選ばせる

- 日付: 2026-10-29 / 発行: Mac main cap
- 実行: 204 remote cap。worker は sonnet か opus（Fable は使わない）。cargo は `CARGO_BUILD_JOBS=2`・`-j 2`、コマンドは逐次（前回 204 が固まった）。
- 作業 dir: `/home/vagrant/work/bantou/develop`（branch develop）。

## 方針（ユーザー指示「IP は自分の IP 列挙して」）

- 設定画面の center 接続設定（`mcp.json` / `claude mcp add`）の URL のホスト部は、自動で 1 つ選ぶのをやめ、自ホストの IP を列挙して選べるようにする。
- 列挙: 自ホストの全 NIC の IP（loopback `127.0.0.1` を含む。LAN、Tailscale 等）。IPv4 を先、IPv6 は後（含めるかは判断して report に）。
- 選んだ IP で接続設定（両形式）が更新される。選択は保存する（次回も同じ IP。無くなっていたら先頭に戻す）。
- bind が loopback の時は `127.0.0.1` 固定（他を選べない、または選ぶと bind と合わない旨を出す。判断は report に）。
- 前回入れた「UDP で外向きアドレスを 1 つ選ぶ」処理は、列挙に置き換える。

## 変更内容

- desktop Rust: IP 列挙（crate 追加か OS API か判断）、Tauri command、接続設定生成が選択 IP を使う。
- desktop UI: 設定画面の接続設定の上に IP の選択（select）。
- テスト: Rust（列挙結果の並び、選択 IP での生成、保存値が無い時の扱い）、e2e mock と settings.spec に IP 切替で接続設定が変わる spec。
- 資料: `desktop/README.md`。

## 範囲外

- version bump、release、main への push。center・server の変更。

## 報告

- 同 dir に `report.md`。develop に commit・push（push まで必ず行う）。
