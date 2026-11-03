# 画像の添付（master-cap の session）

branch: `feature/image-attachments`（base: develop `f0e558f`）。commit: `235d4ec`（feat）、この report。

## 仕様

- desktop のターミナル欄（選択中の session）で 3 経路: Cmd/Ctrl+V（クリップボードに画像があり文字が無い時。文字があれば今まで通り）、画像ファイルのドロップ（欄の上で離した時だけ）、見出し右端の添付ボタン（ファイル選択、複数可）。png / jpeg / gif / webp、1 枚 20MB まで。型違い・超過は理由を見出しに赤字で出して何もしない（他の画像は進む）。送信中は「画像を送信中… N 枚」。
- center: `POST /sessions/<name>/attachments`（外向け token、本文は画像のバイト列、`Content-Type` に型）。`<workspace>/<session 名>/attachments/<yyyymmdd-HHMMSS>-<NN>.<ext>` に書き、201 `{path, bytes, type}`。dir は作る。session 名は `[A-Za-z0-9_-]+`＋未知 session は 404、保存先が workspace 配下かも確認、既存は上書きしない（`wx`、連番 01〜99）、型は Content-Type と先頭バイトの両方、20MB 超は読まずに 413 で閉じる。拒否: 401/404/405/409/413/415/400。
- desktop（Rust）: 読み取りと送信は Rust。ダイアログは rfd、ドロップは Tauri の drag-drop event の path、クリップボードは webview の paste event の画像を raw body で Rust に渡す。Rust が center へ送り（ターミナル入力と同じ接続先・token）、保存できた path を ` <path> `（複数は空白区切りを 1 回で）として `/sessions/<name>/input` に書く。Enter は送らない。
- ログ: center.log に `添付を保存: session= bytes= path=` / `添付を拒否: session= reason=`（本文なし）。desktop は tauri-plugin-log の既存 `bantou.log`。
- 自動削除なし。置き場と手で消す方法は center README の「添付画像」。`packages/protocol` は変更なし。version bump なし。

## 変更ファイル

- center: `src/attachments.ts`（新規）、`src/http.ts`、`src/daemon.ts`（workspace を渡す）、`test/http.test.ts`、`README.md`
- desktop Rust: `src-tauri/src/attachment.rs`（新規）、`lib.rs`（mod・command 登録）、`terminal.rs`（`post` と `Terminals::client` を `pub(crate)` に）
- desktop webview: `src/api/attachment.ts`（新規）、`src/api/index.ts`、`src/components/TerminalView.vue`、`README.md`
- e2e: `e2e/attachment.spec.ts`（新規）、`e2e/mock/bantou.ts`、`e2e/mock/install.ts`（invoke の options を mock へ渡す）
- docs: `docs/design/image-attachments.md`（新規）

## テスト

- center: `bun run test` 284 件 pass（うち添付 4 件）、`bun run typecheck` OK。添付: 保存・連番・型ごとの拡張子・log に本文なし／時刻固定の連番／型違い・中身が画像でない・空・20MB 超（ちょうど 20MB は通る）・未知/不正な session 名・method／認証なし・違う token・workspace 無し。
- cargo test（`src-tauri`）: 261 pass、0 fail、5 ignored（うち添付 10 件: 型の判定、サイズ上限、入力テキストの組み立て、base64、URL、ファイル読み込みの拒否理由、クリップボード bytes、center エラーの取り出し、upload の組み立て〈POST・Content-Type・token・本文〉と 415 の理由）。
- desktop e2e: 全 88 件 pass（新規 8 件: ドロップ、型違い・超過の表示、欄の外のドロップは無視、表示中の session が対象、添付ボタン〈キャンセル・複数・拒否混在〉、クリップボード画像、文字のクリップボードは従来通り、クリップボードの型違い）。
- クリップボードは、合成した `paste` event（`DataTransfer` に `File`）で e2e できたので e2e に入れた。実際の OS クリップボード→ WKWebView の paste event は再現できていない（実機で確認）。
- 実行は Linux（この機）。手順: `bun install`、protocol を build、`bun run build:sidecar`、`bun run generate` の静的ビルドを一時の静的サーバーで配信、ms-playwright の chromium を一時 config で指定。
- `bun run typecheck`（desktop、vue-tsc）はこの機では `MODULE_NOT_FOUND` で動かず未実施（環境の問題。コードの型エラーかは未確認）。`bun run generate`（vite のビルド）は通る。

## 実機（mac）で確かめること

- 画像をコピー（スクショを Cmd+Ctrl+Shift+4 でクリップボードへ等）→ ターミナル欄で Cmd+V → path が入力に入る。文字をコピーして Cmd+V は従来通り。WKWebView が画像の paste event を出すか。
- Finder から画像をターミナル欄にドロップ → path が入る。欄の外では何も起きない。ドロップ位置の判定（物理 px ÷ devicePixelRatio）が Retina で合っているか。
- 添付ボタン → ダイアログで複数選択 → 空白区切りで入る。キャンセルで何も起きない。
- 別ホストの center でも同じ（center ホスト側に `<workspace>/<session>/attachments/` ができる）。入った path を Enter で claude が読めるか。
- 20MB 超・svg・pdf で理由が出る。`bantou.log` と `center.log` に保存・拒否の行が出る。

## 判断・要確認

- 置き場は指示どおり `<workspace>/<session 名>`。session を `path` 指定で作った場合は session の cwd と別（絶対 path なので読める）。center の config に `workspace` が無いと 409。
- ドロップ先は「ターミナル欄の上で離した時だけ」に絞った。Tauri の drag-drop event はウィンドウ全体に来るため、位置で判定している。
- 受けた型は先頭バイトで判定する（拡張子や宣言は信用しない）。
- `post()`（ターミナル入力用）を添付からも使うため `pub(crate)` にした。挙動は変えていない。

## 後始末と残存物

- 一時 playwright config、静的サーバー、一時ディレクトリは削除済み（commit していない）。サーバーと chromium は停止済み（`pgrep`・`ss` で自分の分の残存なし）。
- 残るもの: clone 内の ignored な生成物（`node_modules`、`.output`、`.nuxt`、`src-tauri/target`、`src-tauri/binaries`）。
