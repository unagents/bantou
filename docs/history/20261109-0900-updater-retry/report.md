# updater: 自動確認の再試行と定期再確認

基点 develop e6d7a241e5841049ec426dea4f810584affca7ad / branch fix/updater-retry

## 問題
- 自動更新確認は main window の mount 時に 1 回だけ。起動直後のネットワーク未接続で失敗すると idle に戻り、二度と再試行しない（2026-11-09 mac200 で発生）。

## 変更点（packages/desktop のみ）
- `src/composables/useUpdater.ts`
  - 自動確認が失敗: backoff 1 分 → 5 分 → 30 分で再試行（30 分で頭打ち）。
  - 成功して up to date: 6 時間ごとに再確認。成功で backoff はリセット。
  - timer の発火時に state が idle の時だけ確認する。available / checking / downloading / installing / error には触らない。
  - 手動確認は保留中の自動 timer を止める。手動が up to date なら 6 時間 timer を張り直す。手動が error なら timer なし（ユーザー操作まで再試行しない）。
  - timer はプロセスにつき 1 系統（module 変数 `autoSchedule`）。所有者は main window の composable のみ（token で識別）。2 つ目の instance は timer を張らない。
  - unmount で timer 停止・所有解除。unmount 後の再 mount は起動時確認を再発火せず、6 時間 timer だけ再開。
  - `win.listen` の解決前に unmount した場合も listener を解除。
  - UI（AppHeader.vue）は未変更。自動失敗の `console.error` は失敗ごとに 1 行（再試行ごとに 1 行）。
- `e2e/mock/bantou.ts`: seed `updateCheckFailures`（最初の N 回の `plugin:updater|check` を失敗させる）を追加。
- `e2e/updater.spec.ts`: 7 件追加（Playwright `page.clock` で時間を進める）。
  - 失敗→backoff 1/5/30/30 分で再試行→成功後 6 時間
  - idle の 6 時間定期再確認（3 周期）
  - 手動 up to date で 6 時間周期が再開（timer 1 つ）
  - unmount で timer 停止
  - available では自動確認が動かない
  - 手動 error 後は自動再試行しない
  - （多重起動しないことは上記の「1 周期 1 回」「手動で置換」「unmount 後 0 回」で確認）

## テスト結果
- desktop には unit test の script が無い（e2e のみ）。unit は追加なし。
- `bun run e2e` 相当（nuxt generate の静的ビルドを簡易 node サーバーで配信、ms-playwright chromium-1243 を一時 config で指定）: 全件 135 passed / 0 failed（retries 0）。updater.spec は 9 件全て pass。
- `bun run typecheck`: exit 0、TS error 0 件。ただし vue-tsc が `vue-router/volar/sfc-route-blocks` を解決できず警告を出す（環境起因。docs/history/20261109-1748-settings-single-save にも同じ記録あり）。完全な検証とは言えない。
- cargo test: Rust 無変更のため省略。

## 残課題
- 時間は page.clock による擬似時間。実時間での 6 時間経過・実ネットワーク復帰は未検証（mac200 実機確認が必要）。
- 手動 error 後は自動再試行しない（仕様どおり）。ユーザーが手動で再度押すまで古い版のまま。
- remote に `feature/update-retry` branch が存在する（本作業とは無関係と認識。未確認）。

## review 指摘と対応
- （後で追記）
