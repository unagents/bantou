# 報告: center 欄の残課題 2 点

## 変更ファイル
- desktop/src-tauri/src/center_snippet.rs: `pick_bind` 規則 3 を一覧先頭 → `127.0.0.1`。doc コメントとテスト更新。
- desktop/src-tauri/src/center_mcp.rs: `select_target` を ON なら sidecar、OFF なら保存 remote に変更。テスト `target_sidecar_wins_over_stored_remote_when_enabled`（旧 remote_wins を置換）。
- desktop/e2e/mock/bantou.ts: `center_connection` mock を新仕様に合わせた（ON なら remote 無視）。
- desktop/e2e/center.spec.ts: ON で remote 無視 / OFF で remote 使用の spec を追加（未実行）。
- desktop/README.md: 移行規則 3 と接続先の記述を更新。
- docs/history/20261029-0300-center-section-tidy/report.md: 追記節を追加。

## 挙動の変化
- 移行: bind も connectHost も一覧に無い場合は 127.0.0.1（LAN IP に広がらない）。
- 接続先: center ON は常に自分の sidecar。remote は保存値のまま残り、OFF で再び使われる。接続先は呼び出しごとに設定から決まるため、切替経路の追加変更は無し。保存値を触るコードは入れていない。

## cargo test
- 205 passed / 0 failed / 5 ignored（`CARGO_BUILD_JOBS=2 cargo test -j 2`）。

## 未実施
- e2e 実行: このホストで不可（指示どおり記述のみ）。
- 型チェック: 未実施（前回同様 vue-tsc が環境で起動不可。TS 変更は mock と spec のみ）。

## 後始末
- 起動プロセス無し、一時ファイル無し。前回報告の `desktop/playwright.local.config.ts` の扱いは未確認・未変更。
