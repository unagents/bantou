# bantou (monorepo)

## Map

- `packages/desktop/`: Tauri 2 + Nuxt 4。`src/`（Nuxt、Cork の `src/` 相当）と `src-tauri/`（Rust）。
- `packages/server/`: TypeScript。npm package として npx で起動。desktop からの remote session 起動と remote cap の起動を担う。雛形のみ。
- `packages/protocol/`: desktop・server・plugin 共通のメッセージ仕様と TS 型。雛形のみ。
- `docs/`: 共通資料。`concept.md`（概念、設計判断の前提） / `protocol.md` / `handoff.md`。
- `packages/memory/`: 外部記憶（Nuxt 4 + MCP server、PostgreSQL + pgvector）。設計は `docs/design/external-memory.md` / `memory-design.md`。
- `packages/plugin/`: work session に配る Claude Code plugin `bantou`。
- center は desktop に sidecar 同梱（packages/center を bun build --compile、packages/desktop/scripts/build-sidecar.ts）。

## desktop と server の関係

- desktop = mac/windows のネイティブアプリ。リモート・ローカルのコーディングエージェントとのやり取りを束ねる窓口（マルチプレクサ）。
- server = linux/mac で動く npm package。desktop からの remote session 起動と remote cap 起動を担当。
- desktop と server の通信方式は未決定。

## 役割分離ルール

- `packages/desktop/` と `packages/server/` の中身を互いに混ぜない。
- 両者に共通するものは root の `docs/` と `packages/plugin/` に置く。

## 資料ポインタ

- `packages/desktop/README.md`: bantou-desktop の概要・インストール・Dev。
- `packages/desktop/CLAUDE.md`: E2E on mac200・Release 手順。
- `docs/protocol.md`: work session と bantou のメッセージ仕様。
- `docs/handoff.md`: 開発引き継ぎメモ（Lessons 節を含む）。
- `packages/server/README.md`: bantou-server の概要。

## publish 方針（確定事項）

- 主リポは GitHub `unagents/bantou`。Gitea は pull mirror（読み取り専用）。
- Homebrew tap は別リポ `unagents/homebrew-tap`（`brew tap unagents/tap`）。
- 正本 `packages/desktop/Casks/bantou.rb` から `packages/desktop/scripts/publish-cask.sh` が tap リポの `Casks/bantou.rb` を API 更新する。
- dmg は GitHub Releases に置く。
- server は npm package `bantou` として公開 npm へ publish する。

## 注意

- `packages/desktop/` 配下のコマンド（bun、cargo、tauri build、rsync）は `packages/desktop/` で実行する。
- workspace は root `package.json` の `packages/*`（bun）。`bun install` は repo root で行う。
- npm package `bantou`（`packages/server/`）の protocol 依存は workspace 経由（`^0.2.0`）。desktop の package 名は `bantou-desktop`（server と名前が衝突するため）。
