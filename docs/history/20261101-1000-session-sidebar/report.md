# 報告: セッション一覧を左のサイドメニューに出す

- 実行: 204 remote cap。worker は sonnet 1 体。no-workspace-session の push（`ea9ce75`）の後に着手した。

## 変更ファイル

- `desktop/src/pages/index.vue`: 本体を「左: サイドメニュー / 右: 選んだセッション 1 つの `SessionColumn`」の 2 ペインにした。
  - サイドメニューの 1 行に出すもの: セッション名、ロスト / つながらないのバッジ、件数「進行中 / 待機中」。
  - 選択はメモリだけに持つ。未選択の時と、選んでいたセッションが一覧から消えた時は先頭を選ぶ。
  - セッションが 0 件の時は、従来の空表示（「セッション追加」ボタン付き）を右に出す。
  - testid: `side-row` / `side-lost` / `side-unreachable` / `side-count`。
- `desktop/e2e/fixtures.ts`: `sideRow` / `pickSession` ヘルパーを追加。
- `desktop/e2e/board.spec.ts`: 2 ペイン表示のテストに差し替えた。再読込で選択が残らないテストを追加した。
- `desktop/e2e/session-add.spec.ts`, `ping.spec.ts`, `session-instruct.spec.ts`: セッション選択の操作と、サイドメニューの testid に合わせた。
- mock（`e2e/mock/`）と README: 該当記述なし、変更なし。Rust: 変更なし。

## テスト結果

- e2e（`bun run playwright test`、retries 0）: 54 件中 50 passed / 4 failed。
- 失敗した 4 件はすべて `settings.spec.ts`（「設定を保存した」の strict mode 違反など）。src の変更を stash した baseline でも同じ spec が 4 failed になる。今回の変更とは無関係。
- `board.png`（`desktop/node_modules/.cache/bantou-e2e/shots/board.png`）にサイドメニュー（3 行、件数付き）と右ペインの careery が写っていることを確認した。
- cargo は実行していない（Rust の変更なし）。unit テストは無い。

## 後始末

- dev server / playwright / chromium の残存なし（port 1420 解放、pgrep で該当なし）。
- 残存:
  - `desktop/pw.tmp.config.ts`（untracked の一時 config。commit には含めていない）。
  - `/home/vagrant/work/bantou/scratch-session-sidebar/`（ログ数件と未使用 config）。
  - `/home/vagrant/work/bantou/scratch-no-workspace/`（前タスクの残り）。
- 3 つとも、worker による `rm` は permission で拒否された。前タスクの残りは cap の単独 `rm` でも拒否された。

## 要判断事項

- `settings.spec.ts` の既存の失敗を直すかどうか。前タスクでは 5 件、今回は 4 件だった。
- サイドメニューの件数は「進行中 / 待機中」の数字だけで、ラベルが無い。ラベルを付けるかどうか。
- 上記の残存物 3 つの削除。
