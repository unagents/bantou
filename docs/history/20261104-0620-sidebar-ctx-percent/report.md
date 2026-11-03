# サイドバー session 行の ctx を % だけにする

## 変更の要約
- (a) サイドバーの session 行のコンテキスト使用量を「42%」だけにした。`ContextUsage.vue` に `percent-only` prop を追加。% が不明（窓が不明 / `percent` null）なら何も出さない。80% 以上の警告色は同じ。tooltip に token 数（例: 84k/200k トークン）を追加。右列ヘッダー（`ctx 42% 84k/200k`、窓不明は `ctx 84k`）は変更なし。
- (b) サイドバー行の「working / queued」（0 / 0）の `<span data-testid="side-count">` を削除。中央列のタスク一覧、SessionColumn の見出し内の件数、「進行中・待機中のタスクなし」は触っていない。
- README（packages/desktop）の「セッション一覧」内のコンテキスト使用量の記述を更新。

## 変更ファイル
- packages/desktop/src/components/ContextUsage.vue
- packages/desktop/src/pages/index.vue
- packages/desktop/README.md
- packages/desktop/e2e/context-usage.spec.ts（側は `42%` / `80%` / `0%`、tooltip に `84k/200k`、窓不明は側が非表示でヘッダーが `ctx 805.9k`）
- packages/desktop/e2e/board.spec.ts（側行の `1 / 0`・`1 / 1` の assertion を `not.toContainText` に）

## e2e
- 変更前（develop、旧 spec）: 97 passed / 0 failed
- 変更後: 97 passed / 0 failed（context-usage 4 件・board 8 件含む）
- 方法: `bun run generate` の静的ビルドを node の簡易サーバー（SPA fallback）で配信し、playwright chromium（headless shell）を一時 config で指定。retries 0。
- `bun run build:sidecar` は exit 1 で失敗（原因は未調査。e2e は mock なので影響なし）。

## 入れたもの
- bun 1.4.4（公式 installer、$HOME/.bun）
- playwright chromium（`npx playwright install --with-deps chromium`）

## 未確認
- 実機（Tauri 実アプリ）での見た目。Rust は触っていない。
