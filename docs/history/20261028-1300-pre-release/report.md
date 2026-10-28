# 報告書: 0.1.7 リリース前の修正（204）

- 日付: 2026-10-28 / 作成: 204 remote cap
- worker: sonnet 2 本（r1-claudepath: 要件 1・2、r2-docs-version: 要件 3・4）

## commit

- `85c5ae1` Resolve the claude path for GUI launches and prepare 0.1.7（18 files, +281 / -28）
- 本報告書は別 commit。main への ff はしていない。

## 変更行

| file | 変更 | 内容 |
|---|---|---|
| `packages/center/src/claude-path.ts` | +84（新規） | claude の解決（config → `$SHELL -lc 'command -v claude'`（5 秒）→ `~/.local/bin/claude` → `/opt/homebrew/bin/claude` → PATH、警告付き） |
| `packages/center/test/claude-path.test.ts` | +76（新規） | config 指定、shell 成功、非絶対パス・失敗・timeout、fallback 順、PATH 最終 fallback |
| `packages/center/src/config.ts` | +2 / -2 | `remoteControl.claude` の既定 `"claude"` を外し optional に |
| `packages/center/src/daemon.ts` | +3 / -1 | 起動時に 1 回解決し、ログ `claude 実行ファイル: <path> (source=...)` |
| `packages/center/src/remote-control.ts` | +9 / -1 | 解決結果で起動、`rc_status` / `rc_list` に `claude: { path, source }` |
| `packages/center/test/config.test.ts` | +4 / -1 | 既定値の変更に追従 |
| `packages/center/test/tools.test.ts` | +1 | status の形に追従 |
| `packages/center/README.md` | +13 / -2 | 解決手順 |
| `desktop/src-tauri/src/center.rs` | +37 / -3 | `claudePath`（任意、絶対パス検証、空白のみは未指定）、`remoteControl.claude` へ書き出し、再起動条件に追加、unit test |
| `desktop/src/components/SettingsDialog.vue` | +10 | `claudePath` 入力欄（「空なら login shell から自動解決」） |
| `desktop/src/types/index.ts` | +1 | `claudePath?: string` |
| `desktop/README.md` | +2 / -2 | 設定項目と再起動条件 |
| `desktop/CLAUDE.md` | +15 / -12 | E2E 手順の monorepo 化、Release 手順の修正 |
| `desktop/package.json` / `src-tauri/Cargo.toml` / `src-tauri/Cargo.lock` / `bun.lock` | 各 +1 / -1 | 0.1.6 → 0.1.7 |
| `docs/history/20261028-1300-pre-release/task.md` | +20 | 指示書 |

## 要件 2 の確認結果

- desktop の center 設定の既定は `enabled: false`（Rust の `Default`、既存 test `defaults`、e2e mock）。TS 側に既定値は無い。修正不要。

## desktop/CLAUDE.md の修正（旧 → 新）

- E2E: repo root から mac200 `work/bantou-mono/` へ `rsync -a --delete`（除外: node_modules, target, .nuxt, .output, .git, src-tauri/binaries）→ `packages/protocol` で `npm run build` → root で `bun install` → `desktop` で `bun run e2e`。スクショの取得先を `work/bantou-mono/desktop/node_modules/.cache/bantou-e2e/shots/` に変更。
- Rust の test: `bun run build:sidecar` が先に必要な旨を明記。
- Release 1: bump 対象に `Cargo.lock` を追加。cask は手で編集しない（手順 5 が書き換える）。
- Release 2: push 先を `origin`（GitHub）に固定。`gitea` は読み取り専用ミラーで push しない。
- Release 3: `desktop/` で実行。`beforeBuildCommand` が `bun run build:sidecar && bun run generate` を実行する。
- Release 5: `publish-cask.sh [--dry-run] <ver> <sha256>`。`gh` 認証と `jq` が要る。書き換わった `desktop/Casks/bantou.rb` を commit する。
- Release 4・6・7 は現状と一致、変更なし。

## 検証

- `packages/center`: `npm run typecheck && npm run build && npm test` → pass 84 / fail 0
- `desktop/src-tauri`: `cargo check` → 成功（警告 4 件は既存）。`cargo test --lib center` → 10 passed
- `desktop`: `bun run typecheck` → exit 0。`vue-router/volar/sfc-route-blocks` の解決警告が出るため、故意の型エラーを一時的に入れて exit 2（`error TS2322`）になることを確かめ、型検査が実際に走っていると確認した（probe は除去済み）
- root: `bun install` → `bun.lock` の desktop version が 0.1.7 に更新

## 判断した点

- `remoteControl.claude` を指定した場合は存在検証せずそのまま使う（従来どおり）。
- 解決は center 起動時に 1 回。PATH の最終 fallback では警告をログに出す。
- `claudePath` の変更は子の実行ファイルが変わるため、再起動の対象にした。
- `desktop/Casks/bantou.rb` は `version "0.1.6"` のまま。Release 手順 5 の `publish-cask.sh` が書き換えるため触っていない。

## Mac / mac200 で確認が要る項目

- Finder から起動した app で、center が login shell 経由で `claude` を解決すること（ログと `rc_status` の `claude.source`）。
- 設定ダイアログの `claudePath` 入力と保存後の再起動。
- E2E（新手順、`work/bantou-mono/`）。

## 片付け

- `$TMPDIR` の一時ファイル（worker の `edit*.cjs` / `tc*.log` と前回までの分）は、`rm` が permission で拒否されたため残っている。
