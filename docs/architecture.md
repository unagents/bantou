# bantou アーキテクチャ（2026-10-28 時点の確定事項）

ユーザーと main cap の対話で確定した構成。実装の正本はコードと各 README、仕様の正本は `docs/protocol.md` と `packages/protocol`。

## 構成要素

| 要素 | 置き場 | 役割 |
|---|---|---|
| desktop | `desktop/` | mac / windows のネイティブアプリ。薄いユーザー向け UI。各 master-cap からの承認依頼・対話を一括管理する。アプリ設定（Cork 式 on/off）で裏に center を起動し、接続先の center を設定できる |
| center | `packages/center/`（TypeScript、MCP server） | 素のエージェントが MCP tool 経由で cap 運用できる tool 群。project ごとの `claude remote-control`（server mode、1 project 1 本）の起動・監視・切断復帰を担当する。mac200 では desktop を MCP on で常駐させる |
| server | `server/`（npm package `bantou`、`npx bantou`） | リモートホストの headless 実行層。stroke 方式（`claude -p` を spawn、`--session-id` / `--resume`、path 分離、state 管理、孤児回収）を発展させる。kick を受けて remote cap を起動し、cap の返答で worker を resume で継続する。server mode には触らない |
| protocol | `packages/protocol/` | desktop・center・server・plugin 共通のメッセージ仕様と TS 型 |
| plugin | `plugin/bantou/` | work session に配る Claude Code plugin（guardrail と bantou-protocol skill） |

## 人（モバイル）からの経路

- `claude remote-control`（server mode）の session が master-cap。Claude モバイルアプリ / claude.ai/code から指示を出す
- 公式仕様: 対象は対話 session と server mode のみ。`-p` は対象外。claude.ai の Pro / Max ログイン必須、API key 不可。`--capacity N`、`--spawn same-dir|worktree|session`、`--permission-mode`、切断後は `--continue` で復帰
- 204（Ubuntu、claude 2.1.312）で tmux 無しのバックグラウンド起動が動作することを確認済み（2026-10-28）

## server の実行モデル（stroke 方式の発展）

1. 人の操作は不要（tmux に attach する運用は想定しない）。全エージェントは headless（`claude -p`）
2. server の責務は 3 つだけ: (1) center との窓口、(2) cap の起動と resume、(3) worker からの報告の受け口。server は worker を起動しない
3. center ↔ server は agent-messenger 0.10.0 の protocol 方式でつなぐ。server は起動時に `setProtocol` で bantou protocol（定義は `packages/protocol/messenger/protocol.json` と `PROTOCOL.md`、npm package に同梱）の待受として登録し、終了時に `unsetProtocol` する（peer は `bantou-server` 1 つ）。center は `listPeers("all", {protocol: "bantou"})` で server を発見し（center も server も普通の agent-messenger client として通常の解決 env → config → UDP 発見 → ローカル fallback で broker につなぐ。broker の URL は指名しない。config の `servers` は name のみ、peer 名は自動発見。`servers[].peer` で名前指定も可）、`meta: {protocol: "bantou", version}` 付きで送る。server の返信にも meta が付く。meta 無しの旧形式も当面受ける。登録に失敗しても名前待受で継続する。仕様の正本は `unagents/agent-messenger` の `docs/design/protocol.md`。center から「起動する cap の情報」を含む protocol メッセージが届く。server は「どの cap が、どの center（送信元 peer）の依頼で動いているか」を state で管理する
4. cap の起動と resume は stroke 方式。cap 用の path（`<workspace>/caps/<cap-id>/`）を作り、そこで `claude -p --session-id|--resume <id> -- <prompt>` を実行し、stream-json の stdout で結果を受ける
5. worker は cap の責務。cap は作業をせず、ユーザー指示を解釈して worker に作業させる。軽い作業は cap 内のサブエージェント（Agent tool）、worktree を切る作業は cap が claudep 方式で別 session を起動する。worker への返答も cap が claudep の resume で渡す
6. worker → server: worker は server を MCP（HTTP）として持つ。cap が worker を起動する時の MCP 設定に、header（または環境変数）で `cap_id` と `worker_id` を入れる。token は使わない（認証は全体で後回し）。worker は MCP tool で進捗・質問・承認依頼・完了を送る。tool はすぐ「受け付けた」を返し、worker はそこでターンを終える。実装は Nitro の `/mcp`（Streamable HTTP、stateless）。listener は server が自前で立て（config `mcp.port` / `mcp.bind`、既定 `7902` / `127.0.0.1`）、tool は `report`（`kind`: progress / ask / approve / done、`text`）、header は `x-bantou-cap-id` / `x-bantou-worker-id`
7. server → cap: 報告を受けたら、該当 cap を `--resume` で起動し、prompt に報告内容を渡す。cap ごとにキューを持ち、1 つずつ処理する（実行中の cap には、終わってから渡す）。prompt は `worker <id> から <kind>: <text>`。cap を依頼した center は cap ごとに記録し、report 起因の resume の結果も同じ center へ返す
8. cap → center: cap の結果（stdout の result）を server が state を見て該当 center へ messenger で返す
9. cap の `claude -p` は Bash の sandbox を既定で切って起動する（新規・resume とも `--settings {"sandbox":{"enabled":false}}`。config `session.capBashSandbox`、既定 false、true で従来どおり claude の設定のまま）。理由: 204 の既定は `sandbox.enabled: true` で、sandbox 下の cap の Bash が起動した worker は setsid しても cap の終了で消える。worker を cap の外で生かすために切る。server は worker を起動しないので、worker 側の生存は cap の起動方法に依存する
10. 状態は path ごとの state.json に保存する。起動時に `ps` 照合で孤児プロセスを回収する

## 参考実装

- stroke（Gitea `grrowapp/stroke`）: `server/utils/stroke/claude.ts`（`runClaude`、単独 import 可）、`invoke.ts` / `ai.ts`（retry と状態遷移）、`running.ts`（多重起動防止）、`reap*.ts` / `live-processes.ts`（孤児回収）
- claudep（`stroke-plugin/.origin/tools/claudep`）: Agent SDK `query()` のループ、JSONL ログ、exit 判定

## desktop ↔ center（確定）

- transport は MCP（center の Streamable HTTP `/mcp`）。agent-messenger は使わない。desktop の Rust 側が MCP client を持ち（`desktop/src-tauri/src/center_mcp.rs`）、webview は Tauri command（`center_call` / `center_connection`）経由でのみ center に触れる
- 接続先: 設定 `remote`（別ホストの接続設定を貼り付けて保存した URL と token）があればその center、無ければ sidecar の center（center 有効時のみ）。旧 `remoteUrl` は廃止
- 認証: Cork の MCP Server と同じ方式。center は `/mcp` で `Authorization: Bearer <token>` を検査し、合わない接続は 401。token は desktop が生成（32 文字 base62）して settings の `center.token` に保存し、`center.json` の `token` に書いて sidecar に渡す。再生成すると center を再起動して反映する。http で token が無い・12 文字未満なら center は起動しない
- 接続設定の共有: 設定画面が token 入りの接続設定（`mcp.json` 形式と `claude mcp add --transport http ... --header 'Authorization: Bearer <token>'`）を出す。別ホストの desktop はそれを貼り付け、URL と token を取り出して保存し、MCP client が全リクエストに Bearer を付ける。snippet の URL は bind が loopback なら `127.0.0.1`、wildcard なら desktop 機の外向き（既定経路）のアドレス、それ以外はその bind 値
- bind が loopback 以外の時、center は Host / Origin を絞らず Bearer だけで守る（TLS は無く平文）

## 未決

- 認証（center ↔ server）は後回し。desktop ↔ center は Bearer token（上記）
- cap / worker の path 規約の詳細、state.json の schema
- server を Nuxt（Nitro）に寄せる件は大枠合意済み。`npx bantou` の配布形（Nitro の `.output/`）は実機検証が要る
