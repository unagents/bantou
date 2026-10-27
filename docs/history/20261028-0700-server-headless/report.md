# 報告書: bantou-server を stroke 方式の headless 実行層へ転換（204）

- 日付: 2026-10-28
- 作成: 204 の remote cap（tmux `wcap-bantou`）
- 対象指示書: `task.md`（同ディレクトリ）、確定事項は `docs/architecture.md`
- 実装 commit: `d248344`（`origin develop` へ push 済み。`docs/architecture.md` と `task.md` も同 commit に含む）

## 変更ファイル一覧

| 区分 | パス | 内容 |
|---|---|---|
| 追加 | `docs/architecture.md` | main cap 作成の確定事項（そのまま commit） |
| 変更 | `packages/protocol/src/server.ts` | 旧 `launch_session` / `list_sessions` 系を全削除。`kick_cap` / `resume_worker` / `status` と `cap_result` / `worker_result` / `status_result` / `error`、`AGENT_ID_PATTERN`、`AgentState`、`AgentStatus`、`RunOutcome`、型ガード一式 |
| 変更 | `packages/protocol/test/server.test.mjs`、`README.md` | 新 API のテスト 15 件、内容節の更新 |
| 追加 | `server/src/claude.ts` | stroke `runClaude` の移植（`buildClaudeArgs`、`readResultEnvelope`、`runClaude`） |
| 追加 | `server/src/agents.ts` | cap / worker の起動管理（path 準備、per-agent キュー、retry、session 消失時の新規化、state 更新、`status`、`reapOrphans`、`shutdown`） |
| 追加 | `server/src/state.ts` | `state.json` の読み書き（temp → rename） |
| 追加 | `server/src/paths.ts` | `<workspace>/caps/<id>`、`workers/<id>`、`state.json`、`logs/` |
| 追加 | `server/src/processes.ts` | `ps -ww -e -o pid=,args=` の取得と argv 照合 `matchesSession` |
| 追加 | `server/src/runner.ts` | `AgentRunner` interface、`cliRunner`（実装）、`claudepRunner`（interface のみ、未実装） |
| 変更 | `server/src/config.ts` | `session.{claude,permissionMode,timeoutMs,maxRetries,allowedTools,disallowedTools,extraArgs}`、`broker.bind` 既定 `127.0.0.1`、`workspace` は絶対パス必須、旧 `session.command` はエラー |
| 変更 | `server/src/daemon.ts` | 孤児回収 → broker 起動 → peer 登録 → 指示処理（agent 単位で並行）→ 終了処理 |
| 変更 | `server/src/workspace.ts`、`log.ts`、`cli.ts` | `caps/` `workers/` 作成、致命エラー行も `<ISO> bantou:` 形式 |
| 削除 | `server/src/session.ts`、`server/src/cap.ts`、`server/test/session.test.ts` | tmux 実装とスタブ |
| 追加 | `server/test/{agents,claude,paths,processes,state}.test.ts` | unit test |
| 変更 | `server/test/{config,server}.test.ts`、`server/scripts/e2e-launch.ts`、`server/README.md` | 新フローに合わせて書き直し |

変更していないもの: `desktop/`、`plugin/`、`docs/`（`architecture.md` と history 以外）、依存関係（`@unagents/messenger-*` 0.9.0 のまま）。

## コマンド結果

| 場所 | コマンド | 結果 |
|---|---|---|
| `server/` | `npm run typecheck` / `npm run build` | 成功 |
| `server/` | `npm test` | 70 件 pass、0 fail |
| `packages/protocol/` | `npm run typecheck` / `npm run build` | 成功 |
| `packages/protocol/` | `npm test` | 15 件 pass、0 fail |
| `server/` | `grep -rn tmux src test scripts README.md` | 0 件 |
| `server/` | `E2E_ROOT=/home/vagrant/work/bantou npm run e2e` | `E2E OK`（204、レビュー補修後に再実行して再度 OK） |
| root | `git push origin develop` | `51b1af0..d248344 develop -> develop` |

e2e 後の後始末: `/home/vagrant/work/bantou/` 配下の一時 workspace は削除済み。残るのは claude 側の session 記録（`~/.claude/projects/` 配下、cap 2 回分・worker 1 回分の会話）のみ。

## e2e のログ抜粋（最終実行、204、2026-10-27 21:50 UTC）

```
2026-10-27T21:50:06.332Z bantou: 起動
2026-10-27T21:50:06.336Z bantou: workspace 準備完了: caps=.../ws/caps workers=.../ws/workers
2026-10-27T21:50:06.336Z bantou: 孤児回収: killed=0 failed=0 error=0
2026-10-27T21:50:06.354Z bantou: broker 起動: port=42577 bind=127.0.0.1 discovery=off token=無 id=proA1989
2026-10-27T21:50:06.379Z bantou: peer 登録: name=bantou-server id=tf5pg105 broker=http://127.0.0.1:42577
2026-10-27T21:50:07.387Z bantou: 指示受信: type=kick_cap from=bantou-e2e-sender(n00qdksx) cap_id=e2e-cap-1621086 reason=e2e prompt=Run `echo kicked` in Bash and reply with only the command output on one line.
2026-10-27T21:50:07.389Z bantou: claude 起動: kind=cap id=e2e-cap-1621086 mode=new session=f92604a8-583a-495d-bf5b-0423ed3feccf cwd=.../ws/caps/e2e-cap-1621086
2026-10-27T21:50:15.460Z bantou: claude 終了: kind=cap id=e2e-cap-1621086 session=f92604a8-... ok=true ms=8068 retries=0
2026-10-27T21:50:15.461Z bantou: 返信: to=n00qdksx type=cap_result
2026-10-27T21:50:17.390Z bantou: 指示受信: type=kick_cap from=bantou-e2e-sender(n00qdksx) cap_id=e2e-cap-1621086 prompt=Reply with only the word you echoed in the previous turn.
2026-10-27T21:50:17.393Z bantou: claude 起動: kind=cap id=e2e-cap-1621086 mode=resume session=f92604a8-... cwd=.../ws/caps/e2e-cap-1621086
2026-10-27T21:50:22.083Z bantou: claude 終了: kind=cap id=e2e-cap-1621086 session=f92604a8-... ok=true ms=4689 retries=0
2026-10-27T21:50:22.085Z bantou: 返信: to=n00qdksx type=cap_result
2026-10-27T21:50:23.388Z bantou: 指示受信: type=resume_worker from=bantou-e2e-sender(n00qdksx) worker_id=e2e-worker-1621086 prompt=Reply with only the word pong.
2026-10-27T21:50:23.390Z bantou: claude 起動: kind=worker id=e2e-worker-1621086 mode=new session=cda4dcd7-327e-47e2-88f5-76cc154b13ba cwd=.../ws/workers/e2e-worker-1621086
2026-10-27T21:50:29.596Z bantou: claude 終了: kind=worker id=e2e-worker-1621086 session=cda4dcd7-... ok=true ms=6205 retries=0
2026-10-27T21:50:29.597Z bantou: 返信: to=n00qdksx type=worker_result
2026-10-27T21:50:31.402Z bantou: 指示受信: type=status from=bantou-e2e-sender(n00qdksx)
2026-10-27T21:50:31.414Z bantou: 返信: to=n00qdksx type=status_result
2026-10-27T21:50:33.400Z bantou: 無視: from=bantou-e2e-sender(n00qdksx) text=hello
2026-10-27T21:50:35.498Z bantou: SIGTERM 受信、終了処理
2026-10-27T21:50:35.500Z bantou: broker 停止
2026-10-27T21:50:35.500Z bantou: 終了
E2E OK
```

e2e の検証内容: `cap_result` の `ok` / `result_text`（`kicked` を含む）/ `session_id`（UUID）、`state.json` の `session_id` 一致と `state: idle`、2 回目の kick が同一 session の `mode=resume` で返答に `kicked` を含む、`worker_result` が `pong` を含む、`status_result` に cap と worker が `idle` / `queued: 0` で載る、非コマンドの無視、SIGTERM で exit 0・`broker 停止`・port 解放。

## 事前検証（claude -p の実測、204、claude 2.1.312）

- `claude -p --output-format stream-json --verbose --permission-mode auto --session-id <uuid> -- <prompt>`: 1 行 1 JSON、最終行が `{"type":"result","subtype":"success","is_error":false,"session_id":...,"result":"<本文>",...}`。
- `--resume <uuid>` で前回の文脈を引き継ぐ（`echo kicked` の後に「前回 echo した語は」→ `kicked`）。
- 存在しない id の `--resume`: exit 1、stderr `No conversation found with session ID: <id>`。
- `--output-format json` は JSON 配列を返す（単一オブジェクトではない）ため採用せず、stream-json の最終行で判定する。

## 判断した点

1. **stroke の clone 先は `$TMPDIR`（`/tmp/claude-1002/`）にした。** 指示は `/home/vagrant/work/bantou/` 配下だが、204 では `rm` / `git clean` が permission で拒否され削除を保証できないため、harness が掃除する一時領域に置いた（読み取り専用の参照のみ）。
2. **config の `session.command`（旧 tmux 起動コマンド）は `session.claude`（実行ファイル）に置き換えた。** 意味が変わるため同名を残さず、残っていれば起動時にエラーにする。
3. **`session.timeoutMs` 既定は 30 分、`maxRetries` 既定 1、`permissionMode` 既定 `auto`、ツール制限（`allowedTools` / `disallowedTools` / `extraArgs`）は既定なし。**
4. **retry の対象は timeout と spawn 失敗のみ**（指示どおり）。claude の非 0 終了や result envelope 不正は再試行しない。new 実行の再試行では session 作成の有無が不明なため新 UUID を使う。resume で `No conversation found with session ID` が出た時は 1 回だけ新 UUID の `--session-id` に切り替える（retry 回数には数えない）。
5. **state.json は `<path>/state.json`、`logs/<session_id>.jsonl` に stream-json の生出力を逐次追記。** repo を clone した path では `.git/info/exclude` に `state.json` と `logs/` を追記して clone の git status を汚さない。
6. **`repo` 指定時: path 無し → clone、`.git` あり → fetch のみ、`.git` 無しの既存 path → エラー。** 既存 repo に対する `repo` / `branch` の差分は検知しない（README に明記）。
7. **孤児回収の照合**は argv の ` -- ` より前（prompt を除外）に `-p` / `--print` があり、`--session-id` / `--resume` の直後トークンが session_id と完全一致するものだけ。自分の pid は除外。ps が取れない・kill できない場合は `error` にし、`error` の agent は手動で state.json を直すまで起動しない。
8. **同一 agent は直列、別 agent は並行。** daemon のメッセージ処理は全体直列をやめ（claude 実行が分単位のため）、`status` が実行中でも応答する。
9. **SIGTERM 時は実行中の claude を SIGKILL し `failed`（`server 終了により中断`）にする。** 中断の返信を最大 2.5 秒待ってから peer 解除・broker 停止、5 秒で強制終了。孤児化させず、起動時の回収は異常終了時の保険に位置づけた。
10. **`resume_worker` にも `repo` / `branch` を許可**（指示の「worker 用は同様」に合わせた）。
11. **`broker.bind` 既定を `127.0.0.1` に変更。** loopback 以外に bind して token 無しの場合は前回同様に警告ログ。
12. **レビュー（opus、HIGH 0 / MED 4 / LOW 9）で補修したもの**: ps 照合の誤検知（prompt 内の `--resume <id>` や前方一致）、終了処理中の spawn 取りこぼし、git の無期限待ち（timeout 300 秒・`GIT_TERMINAL_PROMPT=0`）、`error` state からの再起動防止、孤児回収の個別失敗で起動が落ちる、出力全行のメモリ保持、`sessionMissing` の誤検知、prompt / reason の NUL、tmp ファイル残り、相対 workspace、致命エラー行の形式、README の誤記。
13. **git の clone / fetch 経路は unit test 対象外**（ネットワーク禁止）。e2e も `repo` 無しで実行した。実 repo での clone は未検証。

## 範囲外で見つけた問題

- `docs/protocol.md` に server コマンド（`kick_cap` / `resume_worker` / `status` と返信）の仕様文が無い。`packages/protocol/README.md` は正本を `docs/protocol.md` としているが、`docs/` は変更禁止のため未追記。`protocol.md` の `bantou-core` 宛ての task / ask 仕様とは別系統になる。
- e2e は実際に claude を 3 回起動する（今回は各 5〜8 秒、claudeAgent の login を使用）。cwd が空ディレクトリのため軽いが、`~/.claude` のグローバル設定（hooks、CLAUDE.md）は読み込まれる。
- e2e で作られた claude の会話記録（`~/.claude/projects/` 配下）は削除していない（claude 側の保存先で、server の管理外）。
- `server/dist/` に旧 `cap.js` / `session.js` が残る（gitignore 対象、`tsc` は削除しない）。`rm -rf server/dist && npm run build` で消える。
- 前回報告の残件 `server/.npmrc` は既に無くなっていた（今回の git status に出ない）。
- 既存の `.git` がある path へ別 `repo` / `branch` を指定しても検知できない（判断した点 6）。
- `claudepRunner` は interface のみで、呼ぶと `claudep runner は未実装` を投げる。切替口（config など）は未定義。
