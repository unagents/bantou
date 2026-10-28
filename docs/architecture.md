# bantou アーキテクチャ（2026-10-28 時点の確定事項）

ユーザーと main cap の対話で確定した構成。実装の正本はコードと各 README、仕様の正本は `docs/protocol.md` と `packages/protocol`。

## 構成要素

| 要素 | 置き場 | 役割 |
|---|---|---|
| desktop | `desktop/` | mac / windows のネイティブアプリ。薄いユーザー向け UI。各 master-cap からの承認依頼・対話を一括管理する。アプリ設定（Cork 式 on/off）で裏に center を起動し、接続先の center を設定できる |
| center | `packages/center/`（TypeScript、MCP server） | 素のエージェントが MCP tool 経由で cap 運用できる tool 群。project ごとの `claude remote-control`（server mode、1 project 1 本）の起動・監視・切断復帰を担当する。mac200 では desktop を MCP on で常駐させる |
| server | `server/`（npm package `bantou`、`npx bantou`） | リモートホストの headless 実行層。stroke 方式（`claude -p` を spawn、`--session-id` / `--resume`、path 分離、state 管理、孤児回収）を発展させる。Nuxt 4（Nitro、preset `node-listener`）製で、実装は `server/server/utils/bantou/`、起動は `server/server/plugins/01.bantou.ts`、`bin/bantou.mjs` が `.output/server/index.mjs` を起動するkick を受けて remote cap を起動し、cap の返答で worker を resume で継続する。server mode には触らない |
| protocol | `packages/protocol/` | desktop・center・server・plugin 共通のメッセージ仕様と TS 型 |
| plugin | `plugin/bantou/` | work session に配る Claude Code plugin（guardrail と bantou-protocol skill） |

## 人（モバイル）からの経路

- `claude remote-control`（server mode）の session が master-cap。Claude モバイルアプリ / claude.ai/code から指示を出す
- 公式仕様: 対象は対話 session と server mode のみ。`-p` は対象外。claude.ai の Pro / Max ログイン必須、API key 不可。`--capacity N`、`--spawn same-dir|worktree|session`、`--permission-mode`、切断後は `--continue` で復帰
- 204（Ubuntu、claude 2.1.312）で tmux 無しのバックグラウンド起動が動作することを確認済み（2026-10-28）

## server の実行モデル（stroke 方式の発展）

1. 人の操作は不要（tmux に attach する運用は想定しない）。全エージェントは headless（`claude -p`）
2. remote cap は kick を受けた時だけ起動する。起動前に cap 用の path（`<workspace>/caps/<cap-id>/`）を作り、そこで `claude -p --session-id|--resume <id> -- <prompt>` を実行する。同じ cap への kick は直列化する
3. cap は作業を worker（サブエージェント、または worktree 上の別エージェント）に委譲する
4. cap は `spawn_worker`（messenger の `send_message`、宛先 `bantou-server`）で worker を起動させる。server が worker の path を作って起動し、worker と cap の対応を `workers/<id>/owner.json` に残す
5. worker は完了時（`done`）や指示を仰ぐ時（`ask`）に `worker_report` を server へ送る。server は対応する cap を `--resume` で起動し、prompt に report を渡して判断させる
6. cap が worker へ返答する時は `resume_worker`（`claude -p --resume <worker-session>`）で worker を継続させる
7. server が起動する全ての cap / worker には messenger MCP（`bantou-messenger`、内蔵 broker 宛、discovery off）を `--mcp-config` で注入し、system prompt で自分の id と送り先・type を伝える。他の MCP は読ませない（`--strict-mcp-config`）
8. `kick_cap` の送り主は `caps/<id>/reply_to.json` に残し、server が cap を再開した実行の終了時にも `cap_result` をその peer へ送る
9. 状態は path ごとの state.json に保存する。起動時に `ps` 照合で孤児プロセスを回収する

## 参考実装

- stroke（Gitea `grrowapp/stroke`）: `server/utils/stroke/claude.ts`（`runClaude`、単独 import 可）、`invoke.ts` / `ai.ts`（retry と状態遷移）、`running.ts`（多重起動防止）、`reap*.ts` / `live-processes.ts`（孤児回収）
- claudep（`stroke-plugin/.origin/tools/claudep`）: Agent SDK `query()` のループ、JSONL ログ、exit 判定

## 未決

- 認証（desktop ↔ center、center ↔ server）は後回し
- desktop ↔ center の transport（MCP の Streamable HTTP が候補）
- center と server の連携方法（messenger か MCP か HTTP か）
- cap / worker の path 規約の詳細、state.json の schema
- worker が `worker_report` を送らずに終わった時の扱い（現状は何もしない）
- 認証 token を持つ broker で、MCP 注入の token が `--mcp-config` の argv に載る件
