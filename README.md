# bantou

Multi-agent task bridge の monorepo。

## 構成

- `desktop/`: Mac 上で動く bantou-desktop（Tauri 2 + Nuxt 4）。司令塔。
- `server/`: リモートサーバー側で動く bantou-server。bantou-desktop からの指示を受け、リモート側の orchestration を管理する。雛形のみ（業務ロジック未実装）。詳細は `server/README.md`。
- `docs/`: 共通資料。`protocol.md`（work session と bantou のメッセージ仕様）、`guardrail.md`（Claude Code plugin による guardrail）、`handoff.md`（開発引き継ぎメモ）。
- `plugin/`: work session に配る Claude Code plugin `bantou`。
- `Casks/`: Homebrew tap 用の生成物。正本は `desktop/Casks/`。手編集禁止。

## 配布・リリース

`desktop/README.md` の「インストール」節と `desktop/CLAUDE.md` の Release 手順を参照。
