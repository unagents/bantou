# 指示書: center の sidecar 化と desktop からの起動（Cork 方式）

- 日付: 2026-10-28
- 発行: main cap（Mac）
- 宛先: 204 の remote cap（tmux `wcap-bantou`、cwd `/home/vagrant/work/bantou/develop`）
- 置き場: `docs/history/20261028-1100-center-sidecar/task.md`

## お前の立場

前回と同じ。remote cap として worker（実装 `sonnet`、調査 `opus`、`model` 明示。Fable は使うな）に委譲して統括。質問するな。迷う点は推奨案で進め、報告書に「判断した点」として残せ。

## 背景（確定事項）

- center は `packages/center`（TypeScript）のまま開発し、配布は desktop の app bundle に同梱する。方式は Cork（https://github.com/koki-develop/Cork）と同じ: `bun build --compile` で単体バイナリにし、`src-tauri` の `bundle.externalBin`（sidecar）として同梱、アプリが `tauri-plugin-shell` の sidecar で起動する。Cork の `scripts/build-sidecar.ts`、`src-tauri/tauri.conf.json`、設定画面（`src/components/organisms/settings/`）、MCP on/off の持ち方を参考にせよ（`gh api` / `gh repo clone --depth 1` で読める。clone は `$TMPDIR` に置く）。
- `claude remote-control` の起動は desktop 起動時に center が行う（204 での起動確認は設計外。本物の起動テストは mac200 で行うので、ここでは stub と unit で検証する）。
- desktop の実行ユーザーは mac200 の人間ユーザー（claude.ai にログイン済み）。`CLAUDE_CONFIG_DIR` の分離は不要だが、center の `remoteControl.env` で渡せるようにはする。
- 204 では tauri の macOS ビルドはできない。Rust は `cargo check` が通れば可、通らなければ（gtk 等の不足）その旨を報告し、Mac 側の検証に回す。Nuxt 側は `bun run typecheck` と `bun run generate`。

## 要件

### A. center（`packages/center`）

1. transport の追加: `--transport stdio|http`（既定 stdio）、`--port <n>`（http 時、既定 7910）、`--bind`（既定 127.0.0.1）。http は `@modelcontextprotocol/sdk` の Streamable HTTP server transport を Node の `http` で提供する。認証は無し（後回し、README に明記）。
2. `remoteControl.env`（project ごとの `env` も可）を追加し、子プロセスに合成して渡す。
3. 単体バイナリ化: `packages/center/package.json` に `build:bin` script（`bun build --compile src/cli.ts --outfile <out>`、`--target` 指定可）。`file:../protocol` 依存がバイナリに取り込まれることを確認。
4. `desktop/scripts/build-sidecar.ts`（Cork と同じ置き方、bun で実行）: `packages/center` を `bun build --compile` し、`desktop/src-tauri/binaries/bantou-center-<target-triple>` に出力。triple は引数 `--target` か、無ければ `rustc -vV` の host。`desktop/package.json` に `build:sidecar` を追加。
5. unit: http transport の起動と `tools/list` 応答（MCP client で接続）、env 合成、CLI 引数の検証。

### B. desktop（`desktop/`）

6. 設定（Cork 式）: `tauri-plugin-store`（既に依存にある）に `center: { enabled: boolean, port: number, bind: string, projects: [{ name, path, spawn?, permissionMode? }], remoteUrl?: string }` を保存。Nuxt UI の設定ダイアログ（AppHeader から開く）で編集できる。`remoteUrl` は「この Mac の desktop が別ホスト（mac200）の center に接続する」ための URL で、今回は保存と表示のみ（接続機能は次回）。
7. sidecar 起動: `tauri-plugin-shell` を追加し、`bundle.externalBin` に `binaries/bantou-center` を登録。Rust 側 `center.rs`: `enabled` なら起動時に sidecar を `--transport http --port <port> --bind <bind> --config <path>` で起動（config は設定内容から `~/.local/share/bantou/center.json` に書き出す）、設定変更時に再起動、アプリ終了時に停止。状態（stopped / running / error、pid、最終ログ数行）を Tauri command で UI に返し、設定ダイアログに表示する。capabilities に shell の sidecar 許可を追加。
8. `tauri.conf.json`: `beforeBuildCommand` を `bun run build:sidecar && bun run generate` に変更。`src-tauri/.gitignore` の `binaries/` は維持。
9. UI の E2E（Playwright、`desktop/e2e`）: 設定ダイアログの開閉と保存の 1 ケースを追加（Tauri IPC は既存の mock 方式）。実行は mac200 のみなので、ここでは書くだけ（`desktop/CLAUDE.md` の手順どおり後で回す）。
10. `desktop/README.md` と `desktop/CLAUDE.md` に sidecar のビルド手順と設定項目を追記。root `CLAUDE.md` の Map に「center は desktop に sidecar 同梱」を 1 行追記。

### C. 検証と push

11. `packages/center`: typecheck / build / test / `build:bin`（linux 向け）が通ること。`desktop`: `bun install`（root workspaces）、`bun run typecheck`、`bun run generate`、`cargo check`（通らなければ理由を報告）。
12. commit は英語の通常文、`origin develop` へ push。

## 禁止

- `server/`、`plugin/` の変更。
- LAN の本番 broker への登録・送信。本物の `claude remote-control` の起動。
- sudo、systemd、/etc、python。
- ユーザーへの質問。

## 報告

- `docs/history/20261028-1100-center-sidecar/report.md`（commit して push）。必須: 変更ファイル一覧、コマンド結果（通らなかったものは理由）、commit hash、判断した点、Mac / mac200 で検証が必要な項目の一覧。
- 報告後、次の指示まで待機。
