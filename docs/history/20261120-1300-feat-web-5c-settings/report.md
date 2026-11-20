# 5c 設定画面（接続先 center）report

branch: feat/web-5c-settings
基点: 80bd939110f0d1bc6f743f36d86fd10440ae59a6（origin/develop 先頭）

## 作った物
- packages/ui SettingsDialog に web モード分岐。`getPlatform().centerSidecar === false` の時だけ、url・token の設定済み表示・接続状態（`center_connection`）を出す。起動 switch・port・IP・状態・snippet・workspace は出さず、centerStatus / centerLocalIps / centerIpStatus も呼ばない。
- desktop の Platform は `centerSidecar` を持たない（未指定 = desktop の現状）。web の platform は `centerSidecar: false`。
- center-client: redact 時（web）の settings 応答に `envLocks`（CENTER_URL / CENTER_TOKEN 固定か）を足した。desktop の応答の形は不変（test で確認）。token は応答に出ない。
- web: WebHeader に設定ボタン、index.vue で SettingsDialog を開く。
- 5a の guard、protocol、Rust は未変更。

## 採った判断
- 判断 14（未決）: 設計書の推奨 A（web は閲覧のみ、画面から接続先を変えない）。入力欄は常に無効、CENTER_URL / CENTER_TOKEN 固定時は「env で固定」の badge。
- 接続状態は `center_connection` を使う（web の許可 list にある呼び出しのみ）。
- 設定を変えない前提なので保存 button・paste 欄は web では出さない。

## 確認結果
- desktop e2e（packages/desktop、既存 chromium 1243 を一時 config で指定）: 220 passed / 0 failed。commit 前の同じ tree。以後 diff は report 追加のみ。
- web e2e（Playwright、偽 center）: 13 passed（既存 8 + 新規 5）。新規: token が画面・DOM・input 値・全応答・built js・backend log に出ない / 起動系の欄が無い・web で不許可の call が無い・404 / 4xx が 0 / 既定で入力欄が無効 / 接続不可で「つながらない」/ CENTER_URL・TOKEN 固定で「env で固定」。
- center-client test: 230 pass / 0 fail（envLocks の test 追加）。
- packages/web test: 78 pass / 0 fail。
- typecheck: packages/web（nuxt prepare + tsc + nuxt typecheck）rc=0、packages/desktop（nuxt typecheck、ui を含む）rc=0。packages/ui は独自の typecheck script が無く、web・desktop の typecheck で検査される。desktop の log に `vue-router/volar/sfc-route-blocks` の解決 warning が出るが rc=0（この環境の既知の warning、今回の変更と無関係と判断。確認はしていない）。
- nuxt build（packages/web）: 成功。
- 設定ダイアログの保存画像: before-/after-settings-center-{on,off}.png。byte 単位で同一（cmp 一致、md5 同一）。token・IP 欄は塗りつぶし済み、host 名・user 名は写っていない。before は変更前 code で撮った前提（撮影手順の記録は残していない）。人の最終確認用。

## 回さなかった確認
- 実機（スマホ）での表示。実の center は起動していない。
- web e2e は `npx playwright` だと別 version が引かれ失敗するため、`node_modules/.bin/playwright` で実行した（repo の変更ではない）。

## 残った問題
- 判断 14 の A 以外（web から接続先を変える）は未実装。
- web e2e の画像確認は desktop 表示のみ（web モードの画像は保存していない）。
