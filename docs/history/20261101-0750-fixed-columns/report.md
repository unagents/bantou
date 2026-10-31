# fixed-columns 報告

## 原因
- `desktop/src/pages/index.vue` の外枠が `min-h-screen`、本体が `min-h-[calc(100vh-header)]` で、高さが固定されていなかった。
- 中身が増えると document が伸び、サイドメニュー・中央列ごとページがスクロールした。
- `nav` に overflow が無く、`main` の grid 行も内容高に伸びていた。

## 変更ファイル
- `desktop/src/pages/index.vue`
  - 外枠: `h-screen flex-col overflow-hidden`
  - 本体: `min-h-0 flex-1`
  - `nav`: `overflow-y-auto`
  - `main`(grid): `grid-rows-[minmax(0,1fr)]`
  - 右列: 固定 `calc(100vh-…)` を外し `min-h-0 overflow-hidden`
  - セッション無しの `main`: `min-h-0 overflow-y-auto`
- `desktop/e2e/fixed-columns.spec.ts`（新規、2 件）
  - 項目 60 件でも document の scrollHeight が画面高を超えない
  - サイドメニューと中央列がそれぞれ単独でスクロールする
  - その間 document・ヘッダー・サイドメニュー枠・右列の位置が動かない
  - 中央列上のホイールで中央列だけ動く

## テスト
- 修正前: 新規 2 件が失敗（再現確認）。
- 修正後: desktop e2e 73 件すべて pass（既存 71 + 新規 2）。
- 環境: `bun run generate` の静的ビルドを簡易静的サーバーで配信し、ms-playwright の chromium を一時 config で指定。

## 後始末と残存物
- 静的サーバー停止済み。ポート 14200 解放を `ss` で確認。
- 残存: worker 作業 dir の `tmp-e2e/`（一時 config・静的サーバー script・テスト出力・node_modules への symlink）。削除コマンドが権限で拒否されたため未削除。
- 残存: clone 内の ignored 生成物（`node_modules`、`desktop/.output`、`.nuxt`、`packages/protocol/dist`）。
- `bun install` が書き換えた `bun.lock` は戻した。version bump なし。一時 config は commit していない。
