# pane-resize: 3 ペインの幅をドラッグで調整

branch: `feat/pane-resize`（基点 develop）

## 変更点

- `packages/desktop/src/components/PaneResizer.vue`（新規）: 仕切り。pointer events + `setPointerCapture`、キー操作、ダブルクリック。
- `packages/desktop/src/composables/usePaneWidths.ts`（新規）: 幅の状態・最小幅の clamp・localStorage の読み書き。
- `packages/desktop/src/pages/index.vue`: レイアウト部分のみ（ペイン行を `overflow-x-auto` の外枠で包み、nav の幅と main の grid 列を state から指定、仕切り 2 本を挿入、境界の `border-r` 2 本を仕切りの線に置換）。集計 chip・SessionActivityMark には触れていない。
- `packages/desktop/e2e/pane-resize.spec.ts`（新規）、`packages/desktop/README.md`（「ペインの幅」節）。

## 画面

- 仕切り: 当たり判定 6px、通常 1px の線（cork-border）、ホバー / フォーカス / ドラッグ中は accent 3px。cursor は col-resize（ドラッグ中は全体で固定）。
- 操作: ドラッグ、フォーカスして ←→（16px、Shift 64px）、Home / End（最小 / 最大）、ダブルクリックか Enter で既定に戻す。
- 左の仕切りは一覧の幅、右の仕切りは中央列の幅を変える。ターミナル（右）は残りを取る。
- 最小幅: 一覧 160 / 中央 320 / ターミナル 320（px）。既定: 一覧 240 / 中央 420。
- 保存: `localStorage["bantou.paneWidths"] = {"v":1,"side":<px>,"middle":<px>}`。操作の終了時に書く。壊れた値は既定。

## 判断と理由

- 保存先は localStorage。既存に UI 状態の保存は無く（設定は Rust の settings.json / center 側で、画面状態はメモリのみ）、ペイン幅は webview 内で閉じるため。Tauri の webview では localStorage が再起動後も残る（この環境では実アプリ未確認。e2e はブラウザの reload で確認）。
- 窓が最小幅の合計（812px）より狭い場合: 幅を詰めず、ペイン行を横スクロールにした（ターミナルが 320px 未満になって列数が極端に減るのを避ける）。
- 窓が狭い間は表示だけ clamp し、保存値は書き換えない（広げると元の幅に戻る）。
- ドラッグ中の resize 頻度: 既存経路（ResizeObserver → rAF で fit → `term.onResize` → 100ms の debounce → 前回送信と同じなら送らない）で足りると判断し、throttle は足していない。e2e で 60 回の pointermove に対し center への `session_resize` が 15 回未満であることを確認。
- ドラッグ中の取りこぼし: 仕切りが pointer capture を持つため、xterm 上・iframe 上・ウィンドウ外でも move が届く（e2e で再現）。選択防止は pointerdown の preventDefault + `html.pane-resizing`（user-select: none）。

## テスト結果

- `nuxt typecheck`: エラーなし（`bun run typecheck` の中身。bun は host に無いので npx で実行）。
- e2e 全 164 件 pass（新規 11 件含む。flaky なし）。
  - 実行方法: `nuxt generate` の静的ビルドを node の簡易サーバー（127.0.0.1:1431）で配信、`~/.cache/ms-playwright/chromium-1243` を executablePath に指定した作業 dir 内の一時 config、mock の bundle は `bun build` の代わりに esbuild。いずれも commit していない。
  - `pane-resize.spec.ts`: 既定幅と aria / cursor、ドラッグで隣の幅だけ変わる、ドラッグ中の選択なし・表示、ターミナル上とウィンドウ外を通る drag の追従、最小幅を下回らない（3 方向）、狭い窓で最小幅維持と横スクロール・広げると復元、保存と reload 後の復元、壊れた保存値、ダブルクリックで既定、キー操作、ターミナルの resize。

## ターミナル resize の確認

- 経路は `TerminalView.vue` の既存コード（変更なし）。幅が変わる → ResizeObserver → fit → `session_resize`（100ms debounce）。
- e2e: 仕切りを 200px 動かすと mock に届く最後の cols が減り、戻すと増える。60 move 中の送信は 15 回未満。

## 残課題

- 実アプリ（Tauri）での目視と localStorage の永続は未確認（e2e はブラウザ + Tauri IPC mock）。
- 仕切り以外（ウィンドウ端など）からの操作や、幅のスナップ・折りたたみは未実装。
- host に bun が無いため `bun run e2e` / `bun run typecheck` は直接実行していない（上記の代替手順）。
