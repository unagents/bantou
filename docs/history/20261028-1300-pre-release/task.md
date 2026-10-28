# 指示書: 0.1.7 リリース前の修正（204）

- 日付: 2026-10-28 / 発行: main cap / 宛先: 204 remote cap `wcap-bantou`
- 置き場: `docs/history/20261028-1300-pre-release/task.md`

お前は remote cap。worker（実装 sonnet、調査 opus、Fable 禁止）に委譲。質問するな。

## 要件
1. claude の実行パス: GUI 起動の app は PATH が最小なので center が `claude` を見つけられない。
   - desktop 設定に `claudePath`（任意）を追加し、center.json の `remoteControl.claude` に書き出す。
   - 未指定時は center が起動時に `$SHELL -lc 'command -v claude'` で解決し、失敗したら `~/.local/bin/claude`、`/opt/homebrew/bin/claude` を順に試す。解決結果をログと `rc_status` に出す。
   - unit test を追加。
2. desktop の center 設定の既定は `enabled: false` であることを確認（違えば直す）。
3. `desktop/CLAUDE.md` の E2E 手順を monorepo 化後に合わせる: mac200 の新ディレクトリ `work/bantou-mono/` へ repo 全体を `rsync -a --delete`（除外: node_modules, target, .nuxt, .output, .git, src-tauri/binaries）、`packages/protocol` を build → root で `bun install` → `desktop` で `bun run e2e`。Release 手順も現状（push は GitHub、gh release、publish-cask.sh）に合っているか確認し、ずれを直す。
4. version を 0.1.7 に上げる: `desktop/package.json`、`desktop/src-tauri/Cargo.toml`、`Cargo.lock`。
5. 検証: center の typecheck/build/test、desktop の `cargo check` と `cargo test --lib center`、`bun run typecheck`。
6. commit（英語）、`origin develop` へ push。main への ff はまだしない。
7. 報告 `docs/history/20261028-1300-pre-release/report.md`（commit・push）。commit hash と変更行を書け。

禁止: server/・plugin/ の変更、本番 broker、sudo、python、質問。
