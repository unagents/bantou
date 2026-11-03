# 画像の添付（master-cap の session）

利用者が画像（スクリーンショット等）を master-cap の session に渡せるようにする。session の claude は center のホストで動くため、画像は center のホストのファイルになって初めて読める。

## 流れ

1. desktop が画像を受ける（貼り付け・ドロップ・添付ボタン）。
2. Rust が center に `POST /sessions/<name>/attachments`（本文は画像のバイト列、`Content-Type` に型、外向け token）。
3. center が `<workspace>/<name>/attachments/<yyyymmdd-HHMMSS>-<NN>.<ext>` に保存し `{path, bytes, type}` を返す。
4. Rust が保存した絶対 path を ` <path> ` として `/sessions/<name>/input` に書く（Enter なし。複数枚は 1 回にまとめて空白区切り）。

sidecar（127.0.0.1）でも別ホストの center でも同じ route。MCP の `/mcp` と同じ token で、tool 越しではなく ターミナル用の `/sessions/<name>/...` 窓口に足した（pty の入出力と同じく desktop 専用で、MCP の tool 一覧には出さない）。

## 決めたこと

- **本文は生のバイト列**: base64 JSON だと 20MB で約 27MB になり、center の JSON 上限（4MiB）とも別になる。専用の読み取り（上限 20MB、超えたら読まずに閉じる）にした。
- **型の検証は Content-Type と先頭バイトの両方**: 拡張子や宣言だけでは通さない。center と desktop（Rust）の両方で見る（desktop は読み込み前にサイズも見て、無駄に送らない）。
- **ファイル名は center が決める**: 利用者のファイル名は使わない（path traversal・衝突・文字種の問題を避ける）。session 名は既存と同じ `[A-Za-z0-9_-]+` の検証、保存先が `<workspace>` 配下かも確かめる。連番は `wx` で開いて既存を上書きしない。
- **置き場は `<workspace>/<session 名>`**: session を `path` 指定で作った場合は session の cwd と別になる（claude は絶対 path で読めるので動くが、cwd 配下ではない）。workspace が無い center は 409。
- **webview は center に fetch しない**: 画像の読み取り（ダイアログは rfd、ドロップは Tauri の drag-drop event の path）と送信は Rust。クリップボードだけは webview の paste event の画像を、Tauri の raw body（`invoke` に `Uint8Array`）で Rust に渡す（JSON 配列にしない）。
- **自動削除しない**: 置き場所と手で消す方法を README に書く。

## 画像を pty に書く

path だけを入力に入れる。claude が画像を読めるかは claude 側の仕様で、Enter を押すのは利用者。`bantou.log` には保存した path と bytes を残す（画像の中身は残さない）。
