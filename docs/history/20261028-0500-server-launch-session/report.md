# 報告書: bantou-server に broker 内蔵・peer 登録・remote session 起動を実装（204）

- 日付: 2026-10-28
- 作成: 204 の remote cap（tmux `wcap-bantou`）
- 対象指示書: `task.md`（同ディレクトリ）。要件 8 は追加指示で差し替え（依存は npmjs の `@unagents/messenger-broker` / `@unagents/messenger-client` 0.9.0、`server/.npmrc` は作らない）。
- 実装 commit: `2f40287`（`origin develop` へ push 済み）

## 作成・変更ファイル

| 区分 | パス | 内容 |
|---|---|---|
| 変更 | `package.json`（root） | `workspaces` から `server` を外した（理由は「判断した点」） |
| 追加 | `packages/protocol/src/server.ts` | `SERVER_NAME`、`SESSION_NAME_PATTERN`、`ServerCommand`（`launch_session` / `list_sessions`）、`ServerReply`（`session_launched` / `sessions` / `error`）、型ガード `isServerCommand` / `isServerReply` / `parseServerCommand` / `parseServerReply` / `isValidSessionName` |
| 変更 | `packages/protocol/src/index.ts` | `server.ts` を export |
| 追加 | `packages/protocol/test/server.test.mjs` | ガードのテスト 8 件 |
| 変更 | `packages/protocol/README.md` | `server.ts` の記載、未定義節の更新 |
| 変更 | `server/package.json` | 依存 `@unagents/messenger-broker` / `@unagents/messenger-client` 0.9.0、`@agent-hand/bantou-protocol`（`file:../packages/protocol`）、`e2e` script |
| 変更 | `server/src/config.ts` | `broker.{port,bind,discovery,token}` と `session.command` の読込・既定値・検証 |
| 変更 | `server/src/daemon.ts` | broker 起動、古い peer 解除、peer 登録、指示の受理と返信、終了処理 |
| 変更 | `server/src/session.ts` | repo clone/fetch、cwd 検証、tmux session 作成と一覧 |
| 追加 | `server/src/log.ts` | `<ISO> bantou: ...` 形式のログ（改行は空白に畳む） |
| 追加 | `server/scripts/e2e-launch.ts` | e2e スクリプト（`npm run e2e`） |
| 追加 | `server/test/config.test.ts`、`server/test/session.test.ts` | unit test |
| 変更 | `server/test/server.test.ts` | 既定値込みの config テストに更新 |
| 変更 | `server/README.md` | 内蔵 broker、peer 名、指示 JSON、返信、config 全項目、e2e 手順 |
| 追加 | `docs/history/20261028-0500-server-launch-session/task.md`、`report.md` | 指示書と本報告書 |

変更していないもの: `desktop/`、`docs/`（history 除く）、`plugin/`、`Casks`、`server/src/cap.ts`（スタブのまま）。

## 各コマンドの結果

| 場所 | コマンド | 結果 |
|---|---|---|
| `server/` | `npm run typecheck` | 成功 |
| `server/` | `npm run build` | 成功 |
| `server/` | `npm test` | 26 件 pass、0 fail |
| `packages/protocol/` | `npm run typecheck` | 成功 |
| `packages/protocol/` | `npm run build` | 成功 |
| `packages/protocol/` | `npm test` | 13 件 pass、0 fail |
| `server/` | `E2E_ROOT=/home/vagrant/work/bantou npm run e2e` | `E2E OK`（204 で実行、修正後に再実行して再度 OK） |
| root | `git push origin develop` | `c7f76fe..2f40287 develop -> develop` |

e2e 後の後始末確認: `tmux ls` に e2e session は残っていない。`/home/vagrant/work/bantou/` 配下の一時ディレクトリは削除済み。

## e2e のログ抜粋（最終実行、204、2026-10-27 20:18 UTC）

```
2026-10-27T20:18:54.148Z bantou: 起動
2026-10-27T20:18:54.151Z bantou: 設定読込: /home/vagrant/work/bantou/bantou-e2e-rKmVhK/config.json (workspace=/home/vagrant/work/bantou/bantou-e2e-rKmVhK/ws)
2026-10-27T20:18:54.151Z bantou: workspace 準備完了: /home/vagrant/work/bantou/bantou-e2e-rKmVhK/ws/repos
[agent-messenger broker] ℹ v0.9.0 id=proA1989 listening on 127.0.0.1:44597 (state: .../ws/broker.json)
2026-10-27T20:18:54.169Z bantou: broker 起動: port=44597 bind=127.0.0.1 discovery=off token=無 id=proA1989
2026-10-27T20:18:54.195Z bantou: messenger: Registered as peer edb28vpl
2026-10-27T20:18:54.195Z bantou: peer 登録: name=bantou-server id=edb28vpl broker=http://127.0.0.1:44597
2026-10-27T20:18:54.196Z bantou: 常駐開始
2026-10-27T20:18:55.200Z bantou: 指示受信: type=launch_session from=bantou-e2e-sender(odwb50ru) {"bantou":1,"type":"launch_session","name":"bantou-e2e-1586458"}
2026-10-27T20:18:55.212Z bantou: tmux 作成: bantou-e2e-1586458 cwd=/home/vagrant/work/bantou/bantou-e2e-rKmVhK/ws/repos/bantou-e2e-1586458
2026-10-27T20:18:55.213Z bantou: 返信: to=odwb50ru type=session_launched
2026-10-27T20:18:57.204Z bantou: 指示受信: type=list_sessions from=bantou-e2e-sender(odwb50ru) {"bantou":1,"type":"list_sessions"}
2026-10-27T20:18:57.221Z bantou: 返信: to=odwb50ru type=sessions
2026-10-27T20:18:58.203Z bantou: 指示受信: type=launch_session from=bantou-e2e-sender(odwb50ru) {"bantou":1,"type":"launch_session","name":"bantou-e2e-1586458"}
2026-10-27T20:18:58.214Z bantou: エラー: launch_session: tmux session "bantou-e2e-1586458" は既に存在する
2026-10-27T20:18:58.215Z bantou: 返信: to=odwb50ru type=error
2026-10-27T20:18:59.206Z bantou: 無視: from=bantou-e2e-sender(odwb50ru) text=hello
2026-10-27T20:19:01.395Z bantou: SIGTERM 受信、終了処理
2026-10-27T20:19:01.401Z bantou: messenger: Unregistered from broker
2026-10-27T20:19:01.405Z bantou: broker 停止
2026-10-27T20:19:01.405Z bantou: 終了
E2E OK
```

tmux `capture-pane` では claude の trust ダイアログ（`Accessing workspace: .../ws/repos/bantou-e2e-1586458` ... `❯ No, exit / Yes, I trust this folder`）を確認した。server の exit code は 0、終了後に broker の port へ `/health` は接続できないことを確認した。

## 0.8.0（task.md 記載）と 0.9.0 の API 差分

`@agent-hand/messenger-broker@0.8.0` / `@agent-hand/messenger-client@0.8.0`（Gitea）と `@unagents/messenger-broker@0.9.0` / `@unagents/messenger-client@0.9.0`（npmjs）の `dist/*.d.ts` を diff した。export 名・型・関数シグネチャは同一。差分は package scope、`VERSION` 定数、`INSTRUCTIONS` 文字列中の版表記のみ。task.md の記載と異なる点は次の 1 点。

- `startBroker` の options では discovery は `discovery: boolean`（`"off"` 文字列は env `AGENT_MESSENGER_DISCOVERY` 用）。server は config の `"on"` / `"off"` を boolean に変換して渡している。

## 判断した点

1. **root `package.json` の `workspaces` から `server` を外した。** `desktop/package.json` と `server/package.json` が同名 `bantou` のため、npm 10.9.4 は `server/` 内で一切のコマンドを拒否する（`must not have multiple workspaces with the same name`。`npm run typecheck` も失敗する）。完了条件の `cd server && npm run ...` を満たすにはこれが必要だった。`desktop/` は変更禁止のため名前変更はしていない。副作用として `bun.lock` は server を含んだまま古い（元々 `@agent-hand/bantou-server@workspace:server` を指しており、既に古い）。Mac 側で `bun install` を一度流すと整合する。
2. **protocol 依存は `file:../packages/protocol`。** workspace から外したため `workspace:*` は使えない。npm publish 時はこの依存を公開版に差し替える必要がある（publish は今回しない）。
3. **npm publish の前提**: `@unagents/messenger-*` は npmjs 公開済みだが、`@agent-hand/bantou-protocol` は未公開。公開版 `bantou` を install 可能にするには protocol package の公開が先。README に記載した。
4. **broker の状態ファイルは `<workspace>/broker.json`。** 既定の `~/.agent-messenger/broker.json` だと同一 host の単体 broker と状態を共有してしまうため。config 項目にはしていない。
5. **起動時に古い自分の peer を解除する。** 異常終了直後に再起動すると TTL 60 秒の間 `bantou-server` 名が重複し、名前指定の送信が `ambiguous` で失敗するため、起動時に `/list-peers` で同名・同 host の peer を `/unregister` する。
6. **peer 登録の env は明示的に `{AGENT_MESSENGER_DISCOVERY: "off", AGENT_MESSENGER_TOKEN: token}` のみ。** 内蔵 broker に到達できない場合に UDP 発見で LAN の本番 broker へ登録してしまう経路を塞ぐため。
7. **同名 tmux session が既にある場合は `error` を返す**（成功扱いにしない）。
8. **`cwd` 指定時も `mkdir -p` する。** repo 無し・cwd 既定時だけでなく統一した。
9. **既定の `bind 0.0.0.0` / `token` 空は task.md どおり維持。** レビューで「LAN の誰でも未認証で session を起動できる」と HIGH 指摘があったが、既定値は指示事項のため変更せず、loopback 以外に bind かつ token 空のとき `警告:` ログを出すに留めた。運用では `broker.token` の設定を推奨する。
10. **レビュー指摘で補修したもの**: `git clone` に `--` と `--branch=` を使い、`repo` / `branch` / `cwd` は `-` 始まりと NUL を拒否。`cwd` は `mkdir` 後に realpath で再検証（symlink 脱出防止）。重複 session の判定を clone/mkdir より前に移動。`repo` 指定で既存ディレクトリに `.git` が無ければエラー。終了処理は実行中の指示を最大 4 秒待ってから close。ログは 1 行 1 件（改行を畳む）、`指示受信` ログの URL userinfo はマスク。bind `::` の自己接続先は `[::1]`。起動途中の失敗時は broker を close してから終了。
11. **e2e の `capture-pane` のターゲットは `=<name>:`。** tmux 3.7c では `-t =<name>` が `can't find pane` になる（`has-session` / `kill-session` の `=<name>` は動く）。初回 e2e はこれで失敗し、修正して再実行した。
12. **e2e は broker `port: 0`（ランダム）、`bind 127.0.0.1`、`discovery "off"`、env から `AGENT_MESSENGER_*` と `TMUX` を除去して起動。** LAN の本番 broker には一切触れていない。
13. **`server/.npmrc` は commit していない。** 追加指示前に `@agent-hand` scope 用の `.npmrc` を一度作成しており、削除コマンド（`rm`、`git clean`）が 204 の permission / 分類器で拒否されたためディスク上に未追跡のまま残っている。内容は `@agent-hand:registry=http://192.168.1.202/gitea/api/packages/agent-hand/npm/` の 1 行。`@agent-hand/bantou-protocol` は `file:` 依存のため影響しないが、手動で `rm server/.npmrc` してほしい。
14. **broker 自身のログ（consola、`[agent-messenger broker] ℹ ...`）は既存形式に揃えていない。** package 内部のロガーで、library から差し替える export が無い。

## 範囲外で見つけた問題

- `docs/protocol.md` に server コマンド（`launch_session` / `list_sessions` と返信）の仕様文が無い。`packages/protocol/README.md` は「正本は docs/protocol.md」としているが、今回 `docs/` は変更禁止のため未追記。
- `bun.lock`（root）が古い。`@agent-hand/bantou-server@workspace:server`、`bantou@workspace:desktop` を指しており現状の package 名と一致しない。
- `packages/protocol/README.md` の開発手順は `bun install` 前提のままだが、204 では npm（`npm install --workspaces=false`）で動かした。
- Gitea の npm registry URL `.../packages/agent-hand/npm/` は `.../packages/unagents/npm/` へ 307 リダイレクトされる（org 名の移行の痕跡）。今回は npmjs へ切り替えたので影響なし。
- 既存 repo に対して `repo` / `branch` を変えて再送しても fetch のみで反映されない（README 記載どおり）。返信で区別できないので、必要なら `fetched: true` のような印を将来追加する。

## 実行環境メモ（204）

- 作業ユーザー `claudeAgent`、tmux 3.7c、claude 2.1.311、Node 22.22.0、npm 10.9.4。
- e2e は `E2E_ROOT=/home/vagrant/work/bantou npm run e2e` で実行（一時 workspace は `/home/vagrant/work/bantou/bantou-e2e-*`、終了時に削除）。
