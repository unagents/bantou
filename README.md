# bantou

Multi-agent task bridge の monorepo。

## 構成

- `packages/desktop/`: Tauri 2 + Nuxt 4。`src/`（Nuxt、Cork の `src/` 相当）と `src-tauri/`（Rust）。
- `packages/server/`: TypeScript。npm package として npx で起動。desktop からの remote session 起動と remote cap の起動を担う。雛形のみ。詳細は `packages/server/README.md`。
- `packages/protocol/`: desktop・server・plugin 共通のメッセージ仕様と TS 型。雛形のみ。
- `docs/`: 共通資料。`protocol.md`（work session と bantou のメッセージ仕様）、`handoff.md`（開発引き継ぎメモ）。
- `packages/plugin/`: work session に配る Claude Code plugin `bantou`。

## 配布・リリース

`packages/desktop/README.md` の「インストール」節と `packages/desktop/CLAUDE.md` の Release 手順を参照。
