# bantou-server

**雛形のみ（業務ロジック未実装）。** 起動・設定読込・workspace 準備・終了処理だけを持つ常駐プロセス。

## 役割

bantou は multi-agent task bridge で、Mac 上で動く bantou-desktop（`../desktop/`、Tauri 2 + Nuxt 4）が司令塔となる。
bantou-server はリモートサーバー側で動くコンポーネントで、bantou-desktop からの指示を受け、
そのホスト上の orchestration（work session 群）を管理する。
desktop/ から見た「リモートホストのセッション」を扱う窓口がここになる。

## desktop との関係

- desktop が司令塔。指示を出す側。
- server は指示を受ける側。自律的に方針を決めない。

## 確定事項

- 技術スタック: Rust（edition 2021、Tauri なしの Linux 常駐プロセス）。lib（`bantou_server`）＋薄い bin 構成。
- 設定: TOML。キーは `workspace`（workspace フォルダの絶対パス）。例: `workspace = "/path/to/workspace"`
- 設定ファイルの場所: `--config <path>`。省略時は `$HOME/.config/bantou-server/config.toml`。
- workspace 構成: `<workspace>/repos/` が repo の展開先。起動時に `<workspace>` と `<workspace>/repos/` を作成する。
- 常駐: 起動後は常駐し、SIGTERM / SIGINT で後始末して終了コード 0 で終了する。
- systemd user unit のテンプレート: `systemd/bantou-server.service`（未インストール）。

## ビルド・実行

`server/` で実行する。

```
cargo build
cargo test
cargo run -- --config /path/to/config.toml
```

## 未決定事項

- desktop と server の通信方式
- 配置先ホスト
- work session との接続方式（既存 `protocol.md` の agent-messenger 経路（`bantou-core` 宛）をそのまま使うか）

## 関連資料

- [`../docs/protocol.md`](../docs/protocol.md) — work session と bantou のメッセージ仕様（agent-messenger 経由、`bantou-core` 宛）
- [`../docs/guardrail.md`](../docs/guardrail.md) — Open questions 1「リモートホストの session が登録状態を知る手段」。server の守備範囲になりうる
- [`../desktop/README.md`](../desktop/README.md) — bantou-desktop の概要
