# session 作成時のフォルダ（path）指定（desktop）

2026-11-04。branch `feature/session-path-picker`（base develop 51d7f03）。

## 仕様

- 追加ダイアログに「フォルダ」欄。既定は空。空なら `session_create` に `path` を渡さない（center が `<workspace>/<name>`）。
- プレースホルダは center の `workspace` を名前の入力に追従させて出す。`workspace` は center の新 tool `center_info`（別 worker が実装）から Rust `session_path_hints` が取る。取れない時は汎用文。
- 入力は絶対パス。center の error（相対パス・path の衝突・作れない）はダイアログに出す。
- フォルダ選択ダイアログ（既存の `pick_directory` = rfd）は自分の sidecar center かつ macOS / Windows の時だけ。別ホストの center は手入力のみ（「この PC のパスではない」と説明）。
- 歯車ダイアログに session の path を読み取り専用で表示（`session_list` の `path`。「作成時に決まる」と注意）。変更は入れない。

## center 調査

- (a) session_create は path 無しでも mkdir -p で作る。変更不要。
- (b) workspace を返す tool が無い → center に `center_info` が必要（cap 経由で別 worker）。
- (c) path は `session_list` が返している。変更不要。

## 変更ファイル

- Rust: `src-tauri/src/session.rs`（`Session.path`、`create_args(name, path, settings)`、`create_session` の `path`、`session_path_hints`）、`center_mcp.rs`（`current_source`）、`lib.rs`（command 登録）
- フロント: `src/api/sessions.ts`・`src/api/index.ts`・`src/types/index.ts`、`AddSessionDialog.vue`、`ProjectSettingsDialog.vue`、`pages/index.vue`
- e2e: `e2e/mock/bantou.ts`、`e2e/session-path.spec.ts`（新規 6 件）、`e2e/session-instructions.spec.ts`（期待値に `path: null`）
- docs: `packages/desktop/README.md`、`docs/design/project-settings.md`

## テスト

- cargo test: 261 passed（5 ignored）。新規: path は空・空白なら送らない / 渡すと trim して送る、center_info の workspace 読み取り、選択ダイアログの可否（sidecar のみ）、Session.path 読み取り。
- e2e（generate の静的ビルド + 簡易静的サーバー + ms-playwright の chromium_headless_shell）: 全 103 件（新規 6 + 既存 97）。初回 1 件は既存テストが path: null を含まない期待だったため修正。

## review の指摘と対応

（後で追記）

## 残存物

- center の `center_info` tool が未実装なら、プレースホルダは汎用文のまま（動作はする）。
- Linux ではフォルダ選択ダイアログのボタンを出さない（手入力のみ）。
