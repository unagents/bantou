# 報告: center の session / remote tool

- 実行: 204 remote cap（worker: 調査 opus 1 本、実装 sonnet 1 本。Fable 不使用）
- 実装 commit: `d97cbd5`（親 `9b5c61d`）。本 report は別 commit。

## 結果

- A（packages/center）: `session_create` / `session_delete` / `session_list` を追加。
- B（packages/center）: `remote_create` / `remote_delete` / `remote_list` を追加。
- server: 新命令 `stop_cap` を追加。protocol `bantou` を 1.0.0 から 1.1.0 に上げた（`stop_cap` / `stop_result`、error enum に `stop_cap`、`MESSENGER_PROTOCOL` 同期）。
- 既存 tool（`rc_*`、`cap_kick`、`worker_resume`、`server_list`、`server_status`）は残した。
- docs: `packages/center/README.md`、`server/README.md`、`docs/design/center-tools.md`（全面更新、未決 8 項目）、`docs/protocol.md`、`packages/protocol/messenger/PROTOCOL.md`。
- desktop は変更なし。

## test / typecheck（204、全通過）

- protocol: test 18/18、typecheck OK
- center: test 149/149（着手前 111）、typecheck OK
- server: test 104/104（着手前 98）、typecheck OK

## 実測（204、claudeAgent、claude 2.1.312）

broker は隔離した（`AGENT_MESSENGER_HOST=127.0.0.1`、空き port、`AGENT_MESSENGER_DISCOVERY=off`、server config も discovery off、server 内蔵 broker）。center は `--transport http --port 0`。

B:

- owner も header も無い `remote_create` は error（`owner が分からない`）。
- header `X-Bantou-Session: pm-e2e` 付きの `remote_create` は即時に `{remote_id:"r-3e07832b3b", state:"running"}` を返した。約 6 秒後の `remote_list` は `state:"done"`、`result:"PONG"`。
- `remote_list` を別 owner で絞ると `[]` になった。
- `sleep 240` を実行させる指示で、`claude -p` と孫の `sleep 240` が動いている状態を作った。別 owner の `remote_delete` は error、正しい owner では `{deleted:true, stopped:true}`。直後の `ps` で両方が消えた（process group kill）。server ログは `stop 要求` → `stop_result` → `cap_result ok=false error=stop_cap により停止`。

A:

- trust 済み path（`packages/protocol`）で `session_create`: `state:"connected"`、sessionUrl を取得。`ps` で `claude remote-control --name pm-trusted --permission-mode auto` を確認。
- 未 trust の新規 path（`<workspace>/pm-new`）: trust プロンプトは出ず、remote-control が `Error: Workspace not trusted. Please run claude in <path> first...` で即 exit 1。`session_create` は `lastError` にこれを返す（今回追加）。
- center 再起動: `sessions.json` から復元し `--continue` で起動。`No recent session found` で exit 1 し、30 秒以内の早期終了なので素の起動へ fallback した。fallback 起動は `This folder is already served by a terminal claude remote-control on this device. Stop it first.` で止まった。直前に center を強制終了した同じ folder で、約 1 分のロックがあると観測した。原因は未確認。
- `session_delete`: process が消え、`sessions.json` は `[]` になった。

後始末: server / center / claude の停止を確認（`pgrep` 0 件、listen port なし）。残った物は「未解決」に書く。

## 判断した点

### 概念（docs/concept.md に沿う）

- master-cap に持たせる道具（B）は center が持つ。master-cap ごとに agent-messenger の MCP を抱えさせない（原則 2、6）。
- server は省略時に自動で選ぶ。ユーザーには見せない（原則 5）。

### 今は（いずれ変わり得る）

- A の実体: supervisor に動的 entry（add / remove）を足した。起動手段は `claude remote-control --name <name>`。
- A の保存: center の `sessions.json`（config と同じ dir）。config の projects には書かない。
- A の復帰: `--continue`。接続前に早期の error exit なら素の起動へ fallback する。
- A の `<workspace>`: config の projects の `workspace` 項目の path。
- A の拒否条件: name 重複、既存 project 名との衝突、path 重複、相対 path。
- A の未 trust path: 起動に失敗する。center による trust 付与は claude 設定の書き換えになるので入れていない。
- B の owner の優先順: header `X-Bantou-Session` > URL query `session` > tool 引数 `owner`。`remote_create` はどれも無ければ error。`remote_list` は指定が無ければ全件。`remote_delete` は owner が分かる時だけ照合する。owner は自己申告で、認証はしない。
- master-cap に header 付き接続を自動で持たせる仕組みは入れていない。理由: `claude remote-control` は `--mcp-config` / `--settings` を受けない（公式 doc: remote-control の前の global flag は spawn した session に引き継がれない）。`~/.claude.json` を書き換えるとユーザー設定の変更になる。`.mcp.json` には承認プロンプト、未 trust、token 平文の問題がある。移行先: center が master-cap に MCP 設定を渡せる起動手段ができたら、header を自動で付ける。
- B の server 選択: `config.servers` に頼らず、`listPeers`（protocol `bantou`）の先頭を既定にする。`server` 引数は peer id、一致しなければ name。desktop は 2eceed7 から `servers` を書かないので発見ベースにした。
- B の remote: center が `remote_id`（`r-<hex10>`）を採番し、`kick_cap` を返信を待たずに送る。返信で `done` / `failed` に更新し、結果本文を 8000 文字まで保持する。保存はメモリと `remotes.json`。
- `stop_cap`: `claude -p` を detached で起動する。process group ごと SIGTERM し、3 秒後に SIGKILL する。shutdown と timeout も group kill にした。

## 既存 tool と A・B の重複（整理はユーザー判断）

- `rc_list` は `session_list` とほぼ同じ（`session_list` は `source` 付き）。
- `rc_status` は `session_list` の 1 件分とほぼ同じ（args / claude / restarts / environmentUrl を含む点が違う）。
- `rc_start` / `rc_stop` は config の project 用。`rc_stop` は session の entry も止められるが、一覧からは外さない。
- `cap_kick` は `remote_create` の同期版。`cap_id` は呼び手が指定する。既存 cap への追加指示は B に無い。
- `server_list` は `config.servers` ベース。B は発見ベースで、別系統。
- `worker_resume`: B に対応する tool は無い。server は `resume_worker` を処理しない（未対応 error）。
- `server_status`: B に対応する tool は無い。`remote_list` は center の記録で、server の状態は見ない。

## 未解決・限界

- 一時ファイルが残っている: `/tmp/claude-1002/e2e/`（ログ、broker.json、テスト用 token）と `server/.output`（gitignore 済みのビルド成果物）。worker の `rm` と node の `fs.rmSync` が permission で止まった。迂回はしていない。削除には許可が要る。
- claude.ai 側に実測の remote-control session（`session_01TuyNWwewtriSfQSHchW9gF`）の表示が残っている。process は止めた。CLI に削除手段が見つからなかった。
- `stop_cap` は、孫が別の process group に出ていれば止められない。state.json と cap の dir は消さない。stop 要求はその cap の指示がすべて片付くまで有効で、その間に届いた新しい指示も中断される。
- broker に古い peer が残っていると、先頭選択でそれが選ばれる。実測では broker.json を引き継いで再起動した時に起き、指示が届かないまま待ち続けた。先頭選択の見直しは未決。
- center 再起動の時点で `running` だった remote は、復元時に `failed` になる（返信を失うため。server 側では続いている可能性がある）。server の `status` との再同期は未実装。
- 範囲外の気づき（未対応）: `packages/center` の `npm run e2e` は存在しない `server/src/cli.ts` を起動していて壊れている（`e2e.ts:120`）。
- 指示書とドラフトの食い違い: ドラフトでは `rc_*` を A に置き換えるが、指示書は残すとしている。指示書に従った。
