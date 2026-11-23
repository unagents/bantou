# bantou アーキテクチャ（2026-10-28 時点の確定事項）

ユーザーと main cap の対話で確定した構成。実装の正本はコードと各 README、仕様の正本は `docs/protocol.md` と `packages/protocol`。

## 構成要素

| 要素 | 置き場 | 役割 |
|---|---|---|
| desktop | `packages/desktop/` | mac / windows のネイティブアプリ。薄いユーザー向け UI。各 master-cap からの承認依頼・対話を一括管理する。アプリ設定（Cork 式 on/off）で裏に center を起動し、接続先の center を設定できる |
| center | `packages/center/`（TypeScript、MCP server） | 素のエージェントが MCP tool 経由で cap 運用できる tool 群。project ごとの `claude remote-control`（server mode、1 project 1 本）の起動・監視・切断復帰を担当する。mac200 では desktop を MCP on で常駐させる |
| server | `packages/server/`（npm package `bantou`、`npx bantou`） | リモートホストの headless 実行層。stroke 方式（`claude -p` を spawn、`--session-id` / `--resume`、path 分離、state 管理、孤児回収）を発展させる。server mode には触らない |
| protocol | `packages/protocol/` | desktop・center・server・plugin 共通のメッセージ仕様と TS 型 |
| plugin | `packages/plugin/bantou/` | work session に配る Claude Code plugin（bantou-protocol skill） |

## 人（モバイル）からの経路

- `claude remote-control`（server mode）の session が master-cap。Claude モバイルアプリ / claude.ai/code から指示を出す
- 公式仕様: 対象は対話 session と server mode のみ。`-p` は対象外。claude.ai の Pro / Max ログイン必須、API key 不可。`--capacity N`、`--spawn same-dir|worktree|session`、`--permission-mode`、切断後は `--continue` で復帰
- 204（Ubuntu、claude 2.1.312）で tmux 無しのバックグラウンド起動が動作することを確認済み（2026-10-28）

## server の実行モデル（stroke 方式の発展）

1. 人の操作は不要（tmux に attach する運用は想定しない）。全エージェントは headless（`claude -p`）
2. server の責務は 5 つ: (1) center との窓口、(2) cap の起動と resume、(3) cap の依頼による worker の起動・状態・停止、(4) worker からの報告の受け口、(5) cap と worker の出力から生存・進捗を center へ通知。worker を起動すると決めるのは cap、プロセスを起動するのは server（cap の依頼で起動する）
3. center ↔ server は agent-messenger 0.10.0 の protocol 方式でつなぐ。server は起動時に `setProtocol` で bantou protocol（定義は `packages/protocol/messenger/protocol.json` と `PROTOCOL.md`、npm package に同梱）の待受として登録し、終了時に `unsetProtocol` する。center は `listPeers("all", {protocol: "bantou"})` で server を発見し（center も server も普通の agent-messenger client として通常の解決 env → config → UDP 発見 → ローカル fallback で broker につなぐ。broker の URL は指名しない。config の `servers` は name のみ、peer 名は自動発見。`servers[].peer` で名前指定も可）、`meta: {protocol: "bantou", version}` 付きで送る。server の返信にも meta が付く。meta 無しの旧形式も当面受ける。登録に失敗しても名前待受で継続する。仕様の正本は `unagents/agent-messenger` の `docs/design/protocol.md`。center から「起動する cap の情報」を含む protocol メッセージが届く。server は「どの cap が、どの center（送信元 peer）の依頼で動いているか」を state で管理する
4. cap の起動と resume は stroke 方式。cap 用の path（`<workspace>/caps/<cap-id>/`）を作り、そこで `claude -p --session-id|--resume <id> -- <prompt>` を実行し、stream-json の stdout で結果を受ける
5. cap の `claude -p` は Bash の sandbox を既定で切って起動する（新規・resume とも `--settings {"sandbox":{"enabled":false}}`。config `session.capBashSandbox`、既定 false、true で従来どおり claude の設定のまま）。理由: 204 の既定は `sandbox.enabled: true` で、sandbox 下の cap の Bash が起動した子は setsid しても cap の終了で消える。worker は server が起動するので、この影響は受けない。cap の Bash が起動する子の生存のために切る
6. 状態は path ごとの state.json に保存する。起動時に `ps` 照合で孤児プロセスを回収する。cap と worker の持ち主（worker → cap）は `logs/owner.json`、cap を依頼した center は `logs/center.json`

## 参考実装

- stroke（Gitea `grrowapp/stroke`）: `server/utils/stroke/claude.ts`（`runClaude`、単独 import 可）、`invoke.ts` / `ai.ts`（retry と状態遷移）、`running.ts`（多重起動防止）、`reap*.ts` / `live-processes.ts`（孤児回収）
- claudep（`stroke-plugin/.origin/tools/claudep`）: Agent SDK `query()` のループ、JSONL ログ、exit 判定

## desktop ↔ center（確定）

- transport は MCP（center の Streamable HTTP `/mcp`）。agent-messenger は使わない。desktop の Rust 側が MCP client を持ち（`packages/desktop/src-tauri/src/center_mcp.rs`）、webview は Tauri command（`center_call` / `center_connection`）経由でのみ center に触れる
- 接続先: 設定 `remote`（別ホストの接続設定を貼り付けて保存した URL と token）があればその center、無ければ sidecar の center（center 有効時のみ）。旧 `remoteUrl` は廃止
- 認証: Cork の MCP Server と同じ方式。center は `/mcp` で `Authorization: Bearer <token>` を検査し、合わない接続は 401。token は desktop が生成（32 文字 base62）して settings の `center.token` に保存し、`center.json` の `token` に書いて sidecar に渡す。再生成すると center を再起動して反映する。http で token が無い・12 文字未満なら center は起動しない
- 接続設定の共有: 設定画面が token 入りの接続設定（`mcp.json` 形式と `claude mcp add --transport http ... --header 'Authorization: Bearer <token>'`）を出す。別ホストの desktop はそれを貼り付け、URL と token を取り出して保存し、MCP client が全リクエストに Bearer を付ける。center は常に全アドレス（`0.0.0.0`）で待ち受ける。snippet の URL のホストは設定画面で選んだ IP（この PC の IP 一覧から選ぶ。保存値が無ければ外側 IPv4 の先頭、LAN 優先。外側 IP が無い時だけ `127.0.0.1`）。保存済みの IP が今のこの PC に無い時は設定画面が報告し、前のままか新しい IP かを選ばせる
- 待ち受けは全アドレスで、center は Host / Origin を絞らず Bearer だけで守る（TLS は無く平文）

## web（スマホ版。`packages/web/`、5b 時点）

- 構成: Nuxt の SPA（`ssr:false`）と、同じ process の web backend（Nitro）。画面部品は `packages/ui`（Nuxt layer）を desktop と共有する。backend は center の token を持ち、ブラウザには出さない（Cloudflare Access の守りは全要求の前に立つ。設計は別 branch の design.md 5.2）
- transport の継ぎ目: 共有コードは `~/tauri` の `getTransport()` だけを見る。web の実装は `packages/web/app/tauri/transport.ts`（command 名・event 名・payload の型は desktop と同じ）
  - 通常の command: `POST /api/rpc/<cmd>`（body は args の JSON）。event: `GET /api/events`（SSE）
  - 端末: `session_output_start` / `session_output_stop` は session ごとの `EventSource`（`GET /api/sessions/<n>/output[?after=<id>]`）を開閉し、frame を `session-output` / `session-output-status` に写す（`output` → `{id: lastEventId, data}`、`reset`、`status`）。`useTerminalStore` は無変更。切れた接続の再接続と `Last-Event-ID` はブラウザが行い、`CLOSED` になれば `/api/me` で session を確かめた後に `rejected` を出す
  - `session_input` / `session_resize` は JSON を `POST /api/sessions/<n>/input|resize` へ（`dataB64` は `data` に名前を変える）。`session_attach_bytes` は `body` の bytes を、先頭 bytes から決めた画像の Content-Type（png / jpeg / gif / webp）で `POST /api/sessions/<n>/attachments` へ
- 画面: `/`（session 一覧と、タブ「server・cap」）→ `/s/<name>`（共有の `TerminalView`）。server・cap のタブは共有の `RemoteActivity`（cap の状態）と `CenterDialog`（server の版・rc 状態）を使う
- 5b に無いもの（後続）: 特殊キー列・入力欄・入力のまとめ送り（6a）、`visualViewport`・ファイル選択による添付・端末の幅の方式（6b）、設定画面（5c）。端末 page は desktop と同じく、開くと今の幅を `resize` で送る

## 未決

- 認証（center ↔ server）は後回し。desktop ↔ center は Bearer token（上記）
- cap / worker の path 規約の詳細、state.json の schema
- server を Nuxt（Nitro）に寄せる件は大枠合意済み。`npx bantou` の配布形（Nitro の `.output/`）は実機検証が要る
