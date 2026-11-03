# protocol-task の merge と修正（A: develop の merge、B: center の通知先と remote 記録、C: context window、review、merge の順番）

A は w-merge、B は w-fix、C は w-ctx、review は w-review-d の作業。ここに 1 つにまとめる。

## A 節: feature/protocol-task への develop の merge

- merge commit 1bd926c: feature/protocol-task 4d25c0c に origin/develop 5c4143b を merge した。衝突は 9 ファイル。
- 解消方針: develop の「history と legacy を持たない（記録は cap の state・pending・最新 result/error・activity だけ）」を正とし、その上に task_result・worker_reports（最大 20、`WORKER_REPORTS_MAX`）・worker_reply・task_id・ask/approve の返信欄を載せた。
  - `remotes.ts`: develop の pending / result_at / error_at と restore（旧形式の掃除・history→pending 移行）を正にした。`PendingInstruction` に `task_id?` を足した。done_at・notified_at・notify_error は無し。legacy 判定は削除。`onWorkerReport` の通知先は pending の owner。
  - `tools.ts`: remote_list の説明を pending 表現にし、task_result・worker_reports を足した。
  - `center/test/remotes.test.ts`: history 無し・pending 前提のテストを正にした。引数は goal、command は task。
  - README・center-tools.md・protocol.md・architecture.md: 「履歴は持たない」を正にし、task / worker_reply の記述を残し、history・legacy の記述を除いた。
  - desktop の types: develop の `CenterPendingInstruction` を正にし、`CenterTaskResult`・`CenterWorkerReport` を残し、`CenterResultEntry`・`HistoryEntry` を削除した。
  - `RemoteActivity.vue`: develop の 1 行表示（resultHead・待機中）の上に、task_result 表示と ask/approve の返信欄（pendingAsks・sendReply）を載せた。
- A 時点のテスト: center 338 / server 224 / cargo 261（5 ignored）/ desktop e2e 92 pass。
- この後の B で restore の「旧形式の掃除」は止めた（B2）。A の「旧形式の掃除・history→pending 移行」のうち、掃除は B2 で引き継ぎに変わり、history→pending 移行は残る。

## B 節
### B1: server は center を peer の名前で覚える（protocol 1.6.0、server 0.6.0）

- 問題: server が cap の center を peer id で覚えていたため、center を再起動すると peer id が変わり、activity / cap_result / task_result / worker_report が古い id 宛てに送られて消えた（実機で確認: 再起動後、hello の返信だけ届き、動いている cap の activity が一切来なかった）。
- 取り決めの変更（旧 → 新）:
  - 旧: `rememberCenter(cap_id, from_id)`。`logs/center.json` は `{center_id}`。送る時はその id へ。
  - 新: `center.json` は `{center_id, center_name}`。名前（`from_name`。center は `bantou-center`）で覚え、送る時に `listPeers` で今の peer id へ引く。覚えている id が同名の peer にまだいればそれ（同名が複数なら最後に命令を送ってきた id を優先）、いなければ最後に登録した同名の peer（以後それを覚える）。同名の peer が居ない・引けない・旧形式（名前なし）の記録は、覚えている id へそのまま送る。
  - 通知先の更新: `task` / `kick_cap` / `worker_reply` / `stop_cap` / `status`（cap_id 付き）を受けるたびに更新する。`task` / `kick_cap` は従来どおり cap の dir を作る。それ以外（`noteCenter`）はメモリを更新し、cap の dir がある時だけファイルへ書く（無い cap の dir を作らない）。更新待ちで断る `task` / `kick_cap` でも更新する。
  - protocol: `status` に `cap_id?` を追加。`MESSENGER_PROTOCOL` を 1.5.0 → 1.6.0（protocol.json の version も）。1.5.0 の server は `cap_id` を無視するだけ。版が違う server へは center が指示を送らない（follow が更新する）既存の門のまま。server の npm 版は 0.5.0 → 0.6.0（前回の 1.5.0 と同じ扱い）。desktop の version は上げていない。protocol package の version（0.2.0）は前回と同じく変えていない。
  - center: 起動時（`restore`）に、記録の各 cap について server へ `status`（cap_id 付き）を送り、通知先を取り戻す。server が見えなければ 15 秒ごとに最大 20 回再試行する。状態の追従（running / unknown / 未完了の指示あり）で `status` を送る記録は、その `status` が cap_id 付きなので兼ねる（二重に送らない）。`send` の `status` も cap_id 付き。

### B2: center の起動時に旧形式の記録を捨てない

- 旧: 起動時に旧形式（`remote_id` が center の cap_id と違う）の記録を一覧に残さず、`stop_cap` を送って記録を消した。
- 新: 記録を消すのは `remote_delete` だけ。旧形式の記録は、その server の cap として新しい形に引き継ぐ（cap_id はそのまま。`history` は未完了の指示だけ残し、`history` / `legacy` / 記録単位の `owner` は捨てる）。
  - 同じ server（peer id が同じ、または `serverName` + `serverHost` が同じ。`serverHost` を持つ前の旧形式は、今の peer で同名の server が 1 つだけと確かめられた時だけその host の server とみなす。確かめられない（peer が引けない・同名の peer が複数）記録は、グループ化も `stop_cap` もせずそのまま残し、次の `status` 成功時に host を埋める。同名で host が違う server の記録を 1 グループにして片方を止めないため）に複数ある時: 動いている（`running` / `unknown` / 未完了の指示あり）記録を最優先、同順位なら最新（`createdAt` / `finishedAt` / `result_at` / `error_at` のうち最も新しい時刻）を残す。動いている記録が複数なら最新の動いている記録を残し、他へ `stop_cap`（1 回限りの後始末）。他は `stop_cap` を送って（届かなくても）記録を消す。作業ごとの cap の後始末で、1 回限り。
  - cap_id は server ごとに記録が持つ（`remote_id`）。`send` / `status` / `worker_reply` / `delete` はその server の記録の cap_id を使い、記録の無い server だけ center の cap_id（`center-id`）で作る。`remote_id` 省略の `remote_delete` / `worker_reply` は、記録が 1 件ならそれ、複数なら `server` で絞らせる（以前は center の cap_id に決め打ち）。

### 判断が要るかもしれない点

- 「最新」は、旧形式の running の記録より finished の新しい記録を残すことがある（その場合、running 側は `stop_cap` で止まる）。指示どおり最新を残している。
- 残す 1 件の選び方は、利用者の決定「最新の 1 件を残す」からの意図した調整。最新だけで選ぶと、動いている旧 cap より新しい完了済みの記録が残り、動いている cap へ `stop_cap` が飛ぶ（review が実測）ため、動いている記録を最優先にした。新形式（center の cap_id）かどうかは問わない。
- `serverHost` の無い旧記録は、起動時の `status` が成功し、同名の peer がその 1 件だけの時に、今の peer id と host を記録に入れる（同名が複数なら入れない）。

### テスト件数

- protocol: 29 pass（status の cap_id・版 1.6.0 を追加）。
- server: 232 pass（reports に名前で覚える・同名複数・命令で更新・dir を作らない・旧形式・引けない時、daemon に `commandCapId` を追加）。typecheck OK。
- center: 350 pass（旧記録の引き継ぎ、複数あれば最新を残す、動いている記録を最優先（旧 running + 新しい done・指示待ち・active 無しは最新・active 複数は最新の active）、host の無い旧記録の扱い、`remote_delete` 以外で消えない、起動時の status 送信と再試行、server ごとの cap_id、link の `statusOn` の cap_id）。typecheck OK。
- 実機確認は未実施（center 再起動後に activity が届くこと）。

### 変更ファイル

- protocol: `src/server.ts`、`messenger/protocol.json`、`messenger/PROTOCOL.md`、`test/server.test.mjs`。
- server: `server/utils/bantou/daemon.ts`、`reports.ts`、`package.json`、`README.md`、`test/server/utils/bantou/{daemon,reports}.test.ts`。
- center: `src/remotes.ts`、`src/server-link.ts`、`README.md`、`test/{remotes,server-link}.test.ts`。
- docs: `docs/protocol.md`、`docs/architecture.md`、`docs/design/center-tools.md`、`docs/design/master-cap-session.md`。

### 既知の制約（直していない）


- `remote_delete{}`（remote_id 省略）は server の共有 cap へ `stop_cap` を送るので、他の session が指示して動いている分も止まる（cap は server ごとに 1 つで共有）。
- `findPeer` の最後の fallback（名前だけで探す）は、同名の server が複数いると先頭の peer になる。同名複数の環境では、peer id・名前 + host で引けない記録が別 server に送られうる。
- active 判定（`running` / `unknown` / 未完了の指示あり）が複数ある旧記録は、最新の active 以外が `stop_cap` で止まる（1 回限りの後始末。仕様どおり）。

### launcher.test.ts の不安定さ（本 branch 未変更のテスト）

- 「supervisor が引き継いで入れ替わっても…」が 8 回中 1 回 `isAlive(s3) === false` で落ちた。原因: launcher は lock が消えた時点で終わるが、新 supervisor・子のプロセス終了はその少し後になりうる競合。テスト側で終了を `until` で待つ形に直した（本体コードは変更なし。直した後は 16 回中 16 回 pass）。

## review（w-review-d、2 回）の指摘と対応

- 1 回目の指摘: (高) 旧 running を止める選び方（新しい done を残して running の cap へ stop_cap が飛ぶ）、(中) docs の不一致・host 無し記録の取り違え、(低) update_server の文言、launcher.test 不安定（10 回中 3 回）。→ a3f5167・0f6bc85 で解消した。再 review で全て解消を確認した。
- 残り（直していない。判断は利用者）:
  - (中) 旧版で同じ server に running が複数ある時、最新の active 以外へ stop_cap が飛ぶ。仕様どおり・1 回限りの後始末。許容するかの判断が利用者に要る。
  - (低) peer が引けない時、host 無しの記録が 2 件残り、次回の再起動まで畳まれない。
  - (低) `protocol.json` 1.6.0 の description を版を上げずに変更した（update 待ちは task も断る）。1.6.0 がこの branch で導入された未公開版なら問題なし。公開済みの環境があれば PROTOCOL_CONFLICT になりうる。
  - (低) `remote_delete{}` が共有 cap を止める点、`findPeer` の名前のみ fallback（上の「既知の制約」）。
- 最終テスト: center 350 / server 232（10 回連続 pass）/ protocol 29。

## C 節: fix/context-window-from-statusline（w-ctx、先頭 2379d07）

- 概要: context window の大きさは statusLine の JSON `context_window.context_window_size` を正本にする。実機（2.1.317）の形を取得して確認した。`model.id=claude-opus-5-5` で `[1m]` が無くても size=1000000 だった。
- center が `--settings` で statusLine キーだけを渡す。コマンドは center 自身の `status-line` サブコマンド。token は env `BANTOU_SESSION_TOKEN` で渡すので ps に出ない。
- 受け口は `POST /sessions/<name>/status-line`（session token、401、壊れた JSON は 400 + ログ）。statusLine を優先し、無い間は transcript から取る。
- review: 実害なし。軽微 3 件: Windows の `shellQuote` が PowerShell 実行だと構文エラーになる可能性（未検証）、`context_window` 欠落時は 204 でログが無い、利用者の statusLine は無効化される（README / 設計に記載済み）。
- テスト: center 331 / server 204 / cargo 261 / e2e 89 pass。

## merge の順番（案）と試し merge の結果

順番: ① fix/context-window-from-statusline（develop 5c4143b の直上。center だけ・独立）→ ② feature/protocol-task（develop を merge 済み。protocol 1.6.0 / server 0.6.0）→ ③ feature/session-instructions-per-session（develop の直上から。center の remote-control.ts・sessions.ts・tools.ts・config.ts、desktop の types・index.vue・README を触る）。

clone 内の一時 branch で origin/develop に順に merge して試した（push していない。一時 branch は削除済み。衝突は解消していない）:

- ① → develop: 衝突なし。
- ② → (develop + ①): 衝突なし（②の最新 7d4d0f0 + 本 report の追記前の状態）。
- ③ → (develop + ① + ②): 衝突 4 ファイル。
  - `docs/protocol.md`（1 箇所）: remote_send の「Models」の段落。② は `model` 引数を無くして task + `worker_model`、③ は kick_cap 時代の `model` / `model_ignored` の説明を持つ。
  - `packages/center/README.md`（1 箇所）: session の節。② は `session_list` と sessions.json の `name` / `permissionMode` / `createdAt`、③ は `settings`（`settings.instructions`）の説明と sessions.json に `settings` を足す。
  - `packages/center/test/http.test.ts`（1 箇所）: 外向け tool 名の一覧。② は `worker_reply` を含み、③ は `session_settings_get` / `session_settings_update` を含む。両方入れる。
  - `packages/center/test/tools.test.ts`（2 箇所）: 外向け tool の個数（② は 14 個、③ は 15 個）と同じ一覧。
- 切り分け: ③ → (develop + ①) は README の 1 箇所だけ衝突（① が session の節に触れるため）。③ → ② 単独（①無し）は protocol.md・http.test.ts・tools.test.ts の 3 ファイル。README の衝突は ① と ③ の組、残り 3 つは ② と ③ の組。
- 衝突は docs 2 件とテスト 2 件で、`src/` のコードの衝突は無い（解消は未実施）。

## 残存物

- 各 worker の clone（workers/w-*/bantou）は削除済み（w-fix の clone を除く。これは done 後に利用者が消す）。
- w-ctx の capture で作られた `~/.claude-agent/projects` 配下の記録は削除済み。
- `~/.claude-agent/.claude.json` と `~/.claude.json` に、w-ctx の tmp / proj の project 記録が残っている。利用者の実ファイルなので変更していない。
