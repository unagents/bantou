# bantou (monorepo)

## Map

- `desktop/`: Tauri 2 + Nuxt 4。`src/`（Nuxt、Cork の `src/` 相当）と `src-tauri/`（Rust）。
- `server/`: TypeScript。npm package として npx で起動。desktop からの remote session 起動と remote cap の起動を担う。雛形のみ。
- `packages/protocol/`: desktop・server・plugin 共通のメッセージ仕様と TS 型。雛形のみ。
- `docs/`: 共通資料。`protocol.md` / `guardrail.md` / `handoff.md`。
- `plugin/`: work session に配る Claude Code plugin `bantou`。
- `Casks/`: Homebrew tap 用の生成物。正本は `desktop/Casks/`。手編集禁止。

## desktop と server の関係

- desktop = mac/windows のネイティブアプリ。リモート・ローカルのコーディングエージェントとのやり取りを束ねる窓口（マルチプレクサ）。
- server = linux/mac で動く npm package。desktop からの remote session 起動と remote cap 起動を担当。
- desktop と server の通信方式は未決定。

## 役割分離ルール

- `desktop/` と `server/` の中身を互いに混ぜない。
- 両者に共通するものは root の `docs/` と `plugin/` に置く。

## 資料ポインタ

- `desktop/README.md`: bantou-desktop の概要・インストール・Dev。
- `desktop/CLAUDE.md`: E2E on mac200・Release 手順。
- `docs/protocol.md`: work session と bantou のメッセージ仕様。
- `docs/guardrail.md`: Claude Code plugin による guardrail。
- `docs/handoff.md`: 開発引き継ぎメモ（Lessons 節を含む）。
- `server/README.md`: bantou-server の概要。

## publish 方針（確定事項）

- Gitea `agent-hand/bantou` を monorepo として継続する。
- Homebrew は default branch の root `Casks/` しか読まない。
- 正本 `desktop/Casks/bantou.rb` から `desktop/scripts/publish-cask.sh` が root `Casks/bantou.rb` を生成し、Gitea main へ PUT する。
- tap URL・cask url・dmg の Releases は無変更。

## 注意

- `desktop/` 配下のコマンド（bun、cargo、tauri build、rsync）は `desktop/` で実行する。
