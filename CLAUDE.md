# bantou (monorepo)

## Map

- `desktop/`: Mac 上で動く bantou-desktop（Tauri 2 + Nuxt 4）。司令塔。
- `server/`: リモートサーバー側で動く bantou-server。desktop の指示を受けて orchestration を管理する。雛形のみ（業務ロジック未実装）。
- `docs/`: 共通資料。`protocol.md` / `guardrail.md` / `handoff.md`。
- `plugin/`: work session に配る Claude Code plugin `bantou`。
- `Casks/`: Homebrew tap 用の生成物。正本は `desktop/Casks/`。手編集禁止。

## desktop と server の関係

- desktop = 司令塔（Mac）。
- server = リモート側で desktop の指示を受けて orchestration を管理する。
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
