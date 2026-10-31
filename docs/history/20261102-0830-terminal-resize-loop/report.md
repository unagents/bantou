# terminal resize loop / --no-chrome

## 原因
- 右列の高さが中身で決まり、fit のたびに欄が伸びた。そのたびに ResizeObserver が再発火した。
- rows が増え続け、center へ resize を送り続けた。1000 超で 400（cols / rows は 1〜1000 の整数）になった。
- master-cap の対話型 claude が「Claude in Chrome extension detected」の確認で止まった。

## 修正
- `desktop/src/pages/index.vue`: 右列を `100vh - header` で固定し、はみ出しは隠す。
- `desktop/src/components/TerminalView.vue`:
  - 欄と host を `overflow-hidden` にした。
  - fit は `requestAnimationFrame` で 1 フレームに 1 回にした。
  - resize は 100ms で間引き、前回送った値と同じなら送らない。
  - cols / rows は 1〜1000 の整数に丸めた。
- `packages/center/src/wrapper.ts`: claude の引数に `--no-chrome` を追加した（`--permission-mode <値>` の直後）。
- テスト: `desktop/e2e/terminal.spec.ts` に「欄が伸び続けず resize が繰り返し送られない」を追加した。`packages/center/test/remote-control-wrapper.test.ts` を `--no-chrome` に合わせた。

## テスト結果（204）
- e2e（desktop）: 71 件すべて pass。新テストは修正前のコードでは失敗する（欄の高さ 1982→3165px）。
- center: 109 pass / 7 fail。7 件（follow / http / pair / rc 孤児 / remotes / server-link / tools）は修正前の develop でも同じ 7 件失敗する。今回の変更とは無関係。
- Rust: `packages/pty-wrapper` 22 + 10 pass、`desktop/src-tauri` 238 pass / 5 ignored。

## 確認方法
- 204 は Chrome が無く nuxt dev も sandbox で動かない。`bun run generate` の静的ビルドを node の簡易静的サーバー（127.0.0.1:14200）で配信した。
- ms-playwright の chromium（1243）を一時 config で指定して e2e を回した。一時 config は commit していない。
- `src-tauri` の `cargo test` は sidecar の実体（`binaries/*-x86_64-unknown-linux-gnu`）が無く通らない。空のスタブを置いて回した。
- `bun run build:sidecar` は center のテスト（上記の既存 7 件失敗）で止まるため使えなかった。

## 未達・残件
- 後始末が未完: 一時ファイルを `rm` で消せなかった（rm が permission で拒否された）。
  - `/tmp/bantou-e2e-tmp/`（一時 config・静的サーバー script・テスト出力）
  - `desktop/src-tauri/binaries/` の空スタブ 2 ファイル（gitignore 対象、commit には含まれない）
- 静的サーバーは停止済みで、ポート 14200 は解放済み。
- 実機（Tauri 本体）での目視確認はしていない。
