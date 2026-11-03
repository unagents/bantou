# master-cap の CLAUDE.md を設定画面から入力・保存

branch: `feature/session-instructions`（base: develop `888d06a`）。commit は 2 つ（機能、center の protocol 依存整理）+ この report。

## 仕様

- center.json に `sessionInstructions`（文字列、省略可）。空文字・空白だけは「無し」。desktop の `settings.json` の center キー `sessionInstructions` から書き出す（Rust `CenterSettings.session_instructions`、空なら書かない）。
- desktop の設定画面（center の節、claudePath の下）に「master-cap の CLAUDE.md」の複数行入力欄と、「動いている master-cap には次の起動まで効かない（自動では再起動しない）」の注意文。
- center は session の dir の `CLAUDE.md` を、先頭 1 行の印 `<!-- bantou: center の設定から生成。手で直しても次の保存で上書きされる -->` 付きで書く。
  - 書く時: `session_create`（起動前）、起動時の session 復帰（`--continue` 前）、設定の保存時（今ある全 session の dir）。
  - 内容が空: 印のあるファイルを消す。
- 保存時の伝え方: desktop は保存で center.json を書き直す（再起動不要の変更でも書く）。center は config ファイルの更新時刻を 1 秒ごとに見て、変わったら `sessionInstructions` だけ読み直して書き直す。
  - 比べた案: (A) 変更で center 再起動、(B) 再読込の HTTP エンドポイント、(C) SIGHUP、(D) 更新時刻の監視。
  - (A) は全 master-cap が止まり「自動再起動しない」に反する。(B) は desktop に port・token で呼ぶ経路が増える。(C) は center が SIGHUP を終了に使っており Windows に無い。(D) 採用。
- 受け渡しは既存の経路: `centerGetSettings` / `centerSetSettings`、Rust の `CenterSettings`、center の `config.ts`（zod）。再起動の判定（`needs_restart`）には入れていない。

## 判断と注意（依頼文との差）

- 書く先は `<workspace>/<name>` ではなく session の実 path（`path` 指定の session はその path）。cwd と一致させるため。省略時は `<workspace>/<name>` で依頼どおり。
- 空にした時に消すのは印のあるファイルだけ。手で置かれた `CLAUDE.md`（印なし）は消さない（`path` を任意指定した dir の手書きを失わないため）。非空の内容は印の有無にかかわらず上書き（仕様どおり）。**依頼の「空なら消す」より狭い。広げるなら指示が要る。**
- 書けない dir（消えている等）はログに出すだけで、起動・他 session の書き直しは止めない。
- config プロジェクト（`claude remote-control` のサーバー型）は master-cap ではないので対象外。

## 変更ファイル

- center: `src/config.ts`（`sessionInstructions`）、`src/instructions.ts`（新規。印・書く・消す）、`src/config-watch.ts`（新規。更新時刻の監視）、`src/sessions.ts`（create / restore で書く、`setInstructions`）、`src/daemon.ts`（監視の起動と停止）、`test/instructions.test.ts`（新規）、`README.md`。
- desktop: `src-tauri/src/center.rs`（フィールド、validate、`build_config`、`apply` で再起動しない時も config を書く、test）、`src/types/index.ts`、`src/components/SettingsDialog.vue`、`e2e/mock/bantou.ts`、`e2e/settings.spec.ts`、`README.md`。
- docs: `docs/design/master-cap-session.md`（6.2 を追加）。
- 整理（別 commit）: `packages/center/package.json`（`@agent-hand/bantou-protocol` を `^0.2.0`）、`bun.lock`、`packages/center/README.md` の 1 文。

## テスト（repo root で `bun install` → `packages/protocol` で `npm run build` → `bun install --force`）

- center: `bun run test` 277 件 通過 / 失敗 0（前 269 件、+8: config 検証、印と上書き、空で消す・手書きは残す、create、setInstructions（全 session・dir 欠落）、restore、更新監視）。`bun run typecheck` エラーなし。
- desktop: `bun run build:sidecar` 成功（center の compile、pty-wrapper）。`src-tauri` で `cargo test` 246 件 通過 / 失敗 0 / ignored 5（前 245、+1: 設定の往復・config 出力・再起動しない）。
- desktop e2e: `bun run generate` の静的ビルドを簡易静的サーバー（port 1420）で配信し、`ms-playwright/chromium-1243` を一時 config で指定。78 件 通過 / 失敗 0（前 77、+1: 入力欄の表示・注意文・保存・空にして保存）。
- 整理の確認: `bun install` で center が `packages/protocol` へのリンクになる（`node_modules/@agent-hand/bantou-protocol -> ../../../protocol`）。bun.lock の差分は center の依存行と、center 専用の protocol 写し 1 件の削除のみ。上のテストと `build:sidecar`（`bun build --compile`）は整理後に実行し通過。コンパイル済み center の `--help` も起動。

## 実機で確かめること

- 設定画面で「master-cap の CLAUDE.md」を入れて保存し、center 起動中の session の dir に先頭 1 行の印付きの `CLAUDE.md` ができる（約 1 秒以内）。center は再起動しない。
- `session_create` で新しい session を作ると、起動前に `CLAUDE.md` がある。
- 欄を空にして保存すると、`CLAUDE.md` が消える。印の無い手書きの `CLAUDE.md` は残る。
- 起動中の session は、次に起動し直すまで内容が変わらない（Claude Code は起動時に読む。実 claude での読み込みは未確認）。
- 204 は Linux で、macOS の実アプリ（Tauri）での保存経路（`apply` から config を書く部分）は cargo test の範囲外。実アプリで確認する。

## 後始末と残存物

- 一時物（静的サーバー、一時 playwright config、node_modules へのリンク）は worker 作業 dir 内 `tmp-e2e` に置き、サーバーを止め、`find -delete` で消した。port 1420 は解放済み。commit には含めていない。
- 残存: clone の `node_modules`、`packages/desktop/.output`、`src-tauri/binaries`（staged した sidecar）と `src-tauri/target`（いずれも .gitignore 対象）。
- 他の project の chrome / node プロセス（auctioneer）が動いているが、この作業のものではない。
- version bump なし。develop・main へは push・merge していない。
