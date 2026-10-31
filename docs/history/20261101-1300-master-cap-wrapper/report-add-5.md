# 報告: 追加指示 5（develop の e2e `terminal.spec.ts:183`）

- 日付: 2026-11-01 / 実行: 204 remote cap（worker は sonnet、w-desktop）
- 修正 commit: ea73b05（develop ba37da9 の上、fast-forward）と本報告の commit。version bump はしていない。

## 再現

- 204 で mock の invoke に 40ms の遅延を入れると、`terminal.spec.ts` で 2 件が落ちた。
  - :183「the stream state is shown: reconnecting」（mac200 で落ちたもの）
  - :153「keystrokes」（遅延をかけて新たに見つかったもの）

## 原因と修正

assertion は緩めていない。

1. :183 はテスト側の手順の誤りだった。
   - テストは `page.goto` の直後に、待たずに `session-output-status` を emit していた。
   - アプリは `listen` を `attach` の中で非同期に登録する。invoke が遅いと、登録より先に届いたイベントを取りこぼす。
   - 実アプリでは、Rust が状態を emit するのは `session_output_start` の後（`listen` の登録後）だけなので、この順序は起きない。
   - 修正: emit の前に `session_output_start` の呼び出しを待つようにした。他のテストと同じ `streaming()` を使う。
2. :153 は実装の競合だった。
   - セッションを切り替える時、`watch` は旧セッションの detach（`await close()`）を待つ。その間 `current` が旧セッションのままで、その間に打ったキーが旧セッションへ送られていた。
   - 修正（`TerminalView.vue`）: 切り替えた瞬間に `current` を新しいセッションにし、端末をリセットしてから旧セッションを detach する。その間にさらに切り替えられていたら `open` しない。
3. 予防の修正（`useTerminalStore.ts`）: `attach` で、detach の後に遅れて届いた旧ストリームの状態を消す。再表示した時に古い「再接続中」が残らないようにするため。

## テスト結果

| 条件 | 結果 |
|---|---|
| 修正前、40ms 遅延、terminal.spec | 2 failed（:153、:183）/ 5 passed |
| 修正後、遅延なし、全件 | 67 passed / 0 failed |
| 修正後、12ms 遅延、全件 | 67 passed / 0 failed |
| 修正後、40ms 遅延、全件 | 67 passed / 0 failed |
| 修正後、120ms 遅延、terminal.spec | 7 passed |

- Rust の変更は無い（`cargo test` は前回 236 passed）。
- 遅延は確かめるための一時的な変更で、commit には入れていない。
- 204 では、静的ビルドと headless shell で e2e を実行した。mac200 の通常の `bun run e2e` では未確認。

## 後始末

- 起動したサーバーは停止した。ポートも空いていることを確かめた。
- 以下は `rm` が権限で拒否され、残っている。
  - worktree の `desktop/playwright.local.config.ts` と `desktop/.output/`
  - `/tmp/claude-1002/` の下のログ（`d0.log`・`d12.log`・`d40.log`・`d120.log` など）
