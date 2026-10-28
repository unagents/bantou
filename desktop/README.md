# bantou

Multi-agent task bridge. bantou sits between the user and the Claude Code work
sessions: work sessions send questions over agent-messenger, bantou shows them
as waiting icons on a Cork-format task board, and a bantou responder (Claude
Code, started only while the thread is open) helps the user answer and relays
the answer back.

Architecture follows careery: Tauri 2 (Rust) + Nuxt 4 SPA (Nuxt UI +
Tailwind CSS 4). The Rust app shell is derived from careery / [Cork](https://github.com/koki-develop/Cork)
(MIT, see `LICENSE-Cork`).

- Workspace = folder (Cork workspace selection). Flat `*.md`, one task per file,
  file name = title, frontmatter `status` / `order` / `tags` / `date` + `id`.
- Session = tag value. In-progress tasks are listed right under the session,
  queued (first status) below them, done (last status) folded.
- Message format and storage: [`../docs/protocol.md`](../docs/protocol.md).

## インストール（macOS）

Homebrew cask で配る。正本は `desktop/Casks/bantou.rb`。tap の実体は別リポ `unagents/homebrew-tap`。

```sh
brew tap unagents/tap
brew install --cask bantou
```

更新は `brew update && brew upgrade --cask bantou`。リリース時の cask 更新は
`scripts/publish-cask.sh <version> <sha256>`。GitHub の tap リポ `unagents/homebrew-tap` の `Casks/bantou.rb` を API 更新する。

## Dev

```sh
bun install
bun run build:sidecar   # tauri dev / build の前に必須（下記）
bun run tauri dev -- -- "$PWD/fixtures/demo-ws"
```

`fixtures/demo-ws` has three sessions of Cork tasks (waiting threads live in
`~/.local/share/bantou/`, so the UI flows are covered by the e2e seed).

The broker is found with agent-messenger's discovery order (env
`AGENT_MESSENGER_HOST` → `~/.agent-messenger/config.json` → UDP probe →
`127.0.0.1:7901`); bantou keeps no connection setting of its own. In dev, point
`AGENT_MESSENGER_HOST` at a test broker so the dev build does not register a
second `bantou-core` on the shared broker.

## center（sidecar）

`packages/center` を `bun build --compile` した単体バイナリを sidecar（`bundle.externalBin`）として同梱し、アプリが起動・停止する。

- ビルド: `bun run build:sidecar`。出力は `src-tauri/binaries/bantou-center-<rust-triple>`（git 管理外）。`--target <rust-triple>` で指定、無ければ環境変数 `TAURI_ENV_TARGET_TRIPLE`、それも無ければ `rustc -vV` の host。`tauri build` は `beforeBuildCommand` で自動実行する。
- `bundle.externalBin` により、binary が無いと `cargo check` / `tauri dev` のビルドスクリプトも失敗する。先に `build:sidecar` を実行する。
- universal mac ビルドは `aarch64-apple-darwin` と `x86_64-apple-darwin` の両方を `--target` で作る。
- 設定: ヘッダーの歯車から開く設定ダイアログ。center の ON/OFF（「center を起動する」）で同じ場所の表示が入れ替わる。OFF の間は「別ホストの center に接続（貼り付け）」だけを出す（この PC は center を持たず、相手の接続設定を貼ると URL と token を取り出して保存し、sidecar ではなくこちらへ接続する）。ON の間はその欄を出さず、この PC の center の設定（port / bind / token / 接続設定 / projects / servers / claudePath）だけを出す。両者は同時に出ない。保存値は表示を切り替えても消えず、ON に戻すと元の値が出る。項目は enabled / port（既定 7910）/ bind（既定 127.0.0.1）/ projects（name, path, spawn, permissionMode）/ servers（name のみ。broker は center が agent-messenger の通常の解決でつなぎ、bantou-server の peer は protocol で自動発見する。`center.json` の `servers` に `{name}` で書く）/ claudePath（任意・絶対パス。空なら center が login shell から自動解決し、`center.json` の `remoteControl.claude` には設定時のみ書く）/ token（center の Bearer token。初回に自動生成。コピー・再生成ボタンあり。12 文字以上）/ remote（別ホストの center。貼り付けた接続設定の URL と token）。bind は自由入力ではなく、この PC の IP 一覧（全 NIC。IPv4 を先、127.0.0.1 を含む。IPv6 は後。link-local `fe80::` と `::1` は除く）から選ぶ 1 つの select。選んだ IP がそのまま center の待ち受け（`--bind`）であり、接続設定（`mcp.json` 形式と `claude mcp add --transport http ... --header 'Authorization: Bearer <token>'`、タブ切替・コピー可）の URL のホストでもある（IPv6 は URL で `[addr]`）。別の「接続先 IP」欄は無い。token を再生成するか IP を切り替えると接続設定の表示も変わる。保存済みの bind が一覧に無い場合（旧版の `0.0.0.0` / `::` / ホスト名など）は、読み込み時に 旧 `connectHost`（一覧にあれば）、無ければ先頭の IP へ移し替えて保存し直す（`localhost` / `::1` は `127.0.0.1`）。`connectHost` は読み捨てで、以後は書かない。旧版の `remoteUrl` も読み捨てる（保存し直すと消える。貼り付けで入れ直す）。保存先は `settings.json`（tauri-plugin-store）の `center` キー。
- 保存すると `~/.local/share/bantou/center.json` を書き出し、起動中で enabled / port / bind / projects / servers / claudePath / token のいずれかが変わった時だけ再起動する（remote のみの変更は再起動しない。接続先は呼び出しごとに設定から決めるので、次の呼び出しから切り替わる）。enabled を外すと停止する。アプリ起動時に enabled なら自動起動。
- 停止は SIGTERM（center が自身の remote-control 子プロセスを止める。最大 15 秒待って SIGKILL）。Windows は graceful stop が無く center を強制終了するため、子プロセスが孤児として残る場合がある。
- 状態（stopped / running / error、pid、直近ログ）は設定ダイアログに表示する。

### center 状態画面と接続先

- ヘッダーのサーバーアイコンから開く。接続状態（接続先 URL と remote / sidecar の別、接続可否、直近エラー）、`rc_list`（project ごとの remote-control 状態）、`server_list`、各 server の `server_status`（cap / worker 一覧）を表示する。「更新」で再取得する。操作系（rc_start / cap_kick など）は無い。
- 接続先は `remote` があればそれ、無ければ sidecar（`http://127.0.0.1:<port>/mcp`、center 有効時のみ。bind が loopback / wildcard 以外ならその bind）。どちらにも Bearer token を付ける（sidecar は自分の token、remote は貼り付けた接続設定の token。token が無い remote は 401 になり「token が必要」と表示する）。どちらも無ければ「接続先が無い」を表示する。
- desktop の Rust 側が center の MCP（Streamable HTTP）に接続する。webview は直接 fetch せず Tauri command `center_call`（tool 名と引数で呼ぶ。結果は MCP の tool result そのまま、`isError` は Err）と `center_connection`（接続先・接続可否・直近エラー）を使う。center の再起動などで session が切れても次の呼び出しで張り直す。
- 注意: reqwest は TLS 無し（`https://` の remote は接続できない。center 側も TLS 無しで、token は平文で流れる）。center は bind が loopback 以外の時 Host 検査をせず Bearer だけで守るので、別ホストの desktop から使うには bind に LAN 等の IP（127.0.0.1 以外）を選ぶ。待ち受けるのは選んだ 1 つの IP だけで、`0.0.0.0` のような全 IP 待ち受けは選べなくなった。
