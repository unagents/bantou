# bantou-server

**実装未着手。** 役割フォルダのみ用意した状態。

## 役割

bantou は multi-agent task bridge で、Mac 上で動く bantou-desktop（`../desktop/`、Tauri 2 + Nuxt 4）が司令塔となる。
bantou-server はリモートサーバー側で動くコンポーネントで、bantou-desktop からの指示を受け、
そのホスト上の orchestration（work session 群）を管理する。
desktop/ から見た「リモートホストのセッション」を扱う窓口がここになる。

## desktop との関係

- desktop が司令塔。指示を出す側。
- server は指示を受ける側。自律的に方針を決めない。

## 未決定事項

- 技術スタック
- desktop と server の通信方式
- 配置先ホスト
- work session との接続方式（既存 `protocol.md` の agent-messenger 経路（`bantou-core` 宛）をそのまま使うか）

## 関連資料

- [`../docs/protocol.md`](../docs/protocol.md) — work session と bantou のメッセージ仕様（agent-messenger 経由、`bantou-core` 宛）
- [`../docs/guardrail.md`](../docs/guardrail.md) — Open questions 1「リモートホストの session が登録状態を知る手段」。server の守備範囲になりうる
- [`../desktop/README.md`](../desktop/README.md) — bantou-desktop の概要
