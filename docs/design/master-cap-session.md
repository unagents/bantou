# master-cap セッションの起動と出力配信（設計、2026-11-01）

前提は `docs/concept.md`。center の tool 仕様は `docs/design/center-tools.md`。本書はユーザーと合意した方針と、その根拠になった実測をまとめる。未実装。

## 背景（経路テストの結果）

2026-11-01 に全区間の経路テストを行った（mac200、bantou 0.1.23、claude 2.1.312）。

| 区間 | 結果 | 根拠 |
|---|---|---|
| center に session 作成（`session_create`） | 通過 | `pm-route` が `connected` |
| center が master-cap を起動 | 通過 | `claude remote-control --name pm-route` が center の子として起動 |
| 番頭 → master-cap の指示 | 失敗（経路テスト時点） | desktop の「タスク追加を指示」は agent-messenger で session 名宛てに送るが、master-cap は messenger の peer でなかった。→ 下の「6.1」で peer にした |
| master-cap → center の `remote_create` | 失敗 | master-cap の MCP 設定に center が無い（`claude mcp list` で確認）。起動引数にも無い |
| center → server（agent-messenger） | 通過 | アプリ再起動後。更新直後の起動では center だけ broker に届かなかった（下の「別件」） |
| server → remote-cap → worker | 通過 | 起点は Mac main cap の curl（master-cap ではない） |

あわせて、center の MCP が token 1 本で全 tool を公開しており、token を持つ誰でも remote-cap を作れることが分かった（owner は自己申告）。

## 合意した方針

### 1. tool の窓口を分ける

- 外向け（desktop など token を持つ相手）: `session_create` / `session_delete` / `session_list`。
- center が起動したセッション（master-cap）向け: `remote_send`（別名 `remote_create`） / `remote_delete` / `remote_list` / `remote_wait`（2026-11-04 以降。経路テスト当時は `remote_create` / `remote_delete` / `remote_list`）。
- `remote_*` と `cap_kick` は外向けから外す（`cap_kick` も remote-cap を直接起動できるため）。

### 2. master-cap に道具を渡す手段

- ファイルは使わない（セッションのフォルダの `.mcp.json`、`~/.claude.json`、設定ファイルの書き換えはしない）。
- master-cap は対話型の `claude --remote-control <name> --mcp-config '<JSON 文字列>'` で起動する。
  - `--mcp-config` は JSON 文字列を受ける（`claude --help`）。
  - token は JSON に `${VAR}` と書き、起動時の環境変数から展開させる。引数に平文で残さない。
  - header `X-Bantou-Session: <name>` で呼び手のセッションを名乗る。
- claude.ai から見えて操作できること（remote-control）は維持する。

### 3. 構成

```
desktop ──(1 か所)── center ホスト
                       ├ center（TS、コントローラ。MCP の窓口）
                       │   ├ core を中で起動する
                       │   └ wrapper をセッションごとに起動する
                       ├ core（出力のキュー管理と desktop への配信）
                       └ wrapper（Rust、セッションごと）── pty ── claude --remote-control
```

- center（TS）: コントローラ。MCP で来る操作を受ける。core を自分の中で起動する。セッションごとに wrapper を起動し、終了時の再起動・`--continue`・素の起動への切り替え・ログは今と同じく center が持つ。
- core: center と一緒に起動する。セッションごとのキューに、連番のチャンク ID を付けて出力を溜める（上限あり、古い分から消す）。desktop からの入力をセッションへ渡す。
- wrapper（Rust、ネイティブ）: セッションごとに 1 つ。pty を開いて `claude --remote-control` を起動し、入出力を握る。自分で core につなぎ、出力を渡し、入力を受ける。外に口を開けない。center には URL・接続・最後の行・終了コードを伝える。
- desktop: つなぐ先は center ホストだけ（セッションごとの口は持たない）。

### 4. 出力の受け渡し

- desktop は「セッション ID と受け取り済みのチャンク ID」を core に送り、それより後を受け取る。
- desktop はセッションごとにバッファを持ち、溢れた古い部分は捨てる。
- desktop のチャンク ID が古すぎる（core に続きが残っていない）時は、core が持つ分を全部送り、desktop はバッファを全部塗り替える。
- core の溜める量は desktop のバッファより多くする。core の先頭（出力の途中から始まる中途半端な部分）は、塗り替えの途中で desktop のバッファから押し出されて消える。画面の状態を別に保持する仕組みは持たない。
- スリープ復帰やネットワーク変化でつなぎ直しても、続きから受け取れる。

### 5. 画面

- 並びは「サイドメニュー｜リモート指示タスクの一覧｜対話の履歴（入力欄付き）」。
- 対話の履歴は、wrapper の pty の画面を映す（ターミナルの見た目）。画面でしか答えられない許可確認も bantou で答えられる。

### 6. 番頭から master-cap への指示（ユーザー決定）

- 「タスク追加を指示」ボタンはやめる。ユーザーは右の欄（対話の履歴）で master-cap に直接話す。対話セッションと同じ仕様にする。

### 6.1 master-cap を messenger の peer にする（2026-11-03）

center の通知（remote の完了通知など）は owner の session 名の messenger peer へ `push` で送る。そのため session ごとに agent-messenger を組み込み、session 名を peer 名にする。

- 方法: `--mcp-config` の JSON に stdio の MCP `bantou-messenger` を足す。plugin `messenger`（agent-messenger の `plugins/messenger/.mcp.json`）と同じ `npx -y @unagents/messenger@<版> mcp` で、env `AGENT_MESSENGER_NAME=<session 名>` を渡す。名前は MCP の env だけに入れる（claude 本体の環境変数には入れない。plugin も入っている環境で同名 peer が 2 つ並ぶのを避ける）。
- 根拠（agent-messenger 0.12.0 のコード）: client の `loadConfig` が `AGENT_MESSENGER_NAME` を peer 名にし、登録時に broker へ送る。受信は client が Claude Code の inbox socket（`CLAUDE_CODE_MESSAGING_SOCKET`、claude が MCP 子プロセスへ継承、Claude Code 2.1.224 以降）へ書き、会話に別セッションのメッセージとして現れる。`delivery: "push"` は本文そのもの。pty への文字の書き込みは使わない。
- broker は center と同じく client が自分で解決する（env `AGENT_MESSENGER_HOST` → `~/.agent-messenger/client.json`・旧 config → UDP 発見 → `127.0.0.1:7901`）。center は broker を指名しない。
- 再起動・`--continue`: `launch()` が起動のたびに `--mcp-config` を組み直すので、同じ session 名で登録し直される。peer id は変わる。
- 同名の古い登録: broker は同じ pid + hostname の再登録だけを置き換える。再起動で pid が変わり、旧 client が unregister せず落ちた（SIGKILL・wrapper 異常終了）時は、heartbeat 失効（60 秒）まで同名の peer が 2 つ並ぶ。center の `notifyPeer` は同名が複数なら `registered_at` が最新のものへ送る。この間、他の peer が名前宛て（`send_message to: <session 名>`）で送ると broker は ambiguous で拒否する（id 宛ては届く）。
- 実測（2026-11-03、204、agent-messenger 0.12.0 の broker を作業 dir で起動）: (1) 上記 MCP 設定で client が session 名で登録、(2) center の `notifyPeer` の push が inbox socket に届く、(3) client を SIGKILL して再起動すると同名 2 件が並び、`notifyPeer` が新しい方へ届く、(4) 実 claude 2.1.317 に同じ `--mcp-config` を渡すと peer 名で登録され、着信通知が会話に出る（env `AGENT_MESSENGER_HOST` / `PORT` も MCP に届く）。
- 範囲外: config の `projects`（`claude remote-control` のサーバー型）は `--mcp-config` を受けないので対象外（messenger の peer にならない）。
- 前提: center の子プロセスの PATH に `npx` があること。初回は npx の取得で起動が遅れる。bantou の MCP 窓口（`mcpUrl`）が無くても messenger は付ける。

### 7. desktop のセッション一覧は center の `session_list` そのもの（ユーザー決定、追加指示 1）

- サイドメニューのセッション一覧は、つないでいる center（自分の sidecar、または貼った別ホストの center）の `session_list` をそのまま出す。desktop のメモリの「追加済み」一覧（`session.rs` の `Sessions`、`add_sessions`、`reconcile` の lost 判定）はやめる。center 側で作られたセッション（他の desktop や MCP から）も出るようにするため。
- 取り直しの時機は、操作前・スリープ復帰・ネットワーク変化・設定を閉じた時・5 分ごとに加え、center のセッションが増減した時。center は SSE（`GET /events`、外向け token）でセッション一覧の変化を知らせ、desktop はそれを受けて `session_list` を取り直す。
- center に問い合わせられない時は、最後に取れた一覧を「つながらない」表示付きで出す。
- 「セッション追加」は新規作成（`session_create`）だけにする。一覧から選んで追加する画面は無くす。

## 実測（2026-11-01、mac200、claude 2.1.312）

| 試したこと | 結果 |
|---|---|
| サーバー型 `claude --mcp-config '<JSON>' remote-control …` | 起動拒否（`--mcp-config before remote-control is not carried over …`） |
| サーバー型 `claude remote-control … --mcp-config '<JSON>'` | 起動拒否（`Unknown argument: --mcp-config`） |
| サーバー型 `claude --settings '{}' remote-control …` | 起動拒否 |
| サーバー型 + フォルダの `.mcp.json` と `.claude/settings.local.json`（`enabledMcpjsonServers`） | 承認なしで接続し、`${HOME}` 展開と header も届いた（ファイルを使うので不採用） |
| 対話型 `claude --remote-control <name> --mcp-config '<JSON 文字列>'`、端末なし | `--print` 扱いで起動しない（`Input must be provided …`） |
| 同上を pty の中で起動 | Remote Control 有効（session URL 表示）、文字列の MCP に接続、`${BT_PROBE_TOKEN}` 展開、header 到達 |
| `claude -p --input-format stream-json --output-format stream-json --remote-control <name>` | 応答は返るが remote-control は有効にならない |
| 同上 + `--settings '{"remoteControlAtStartup":true}'` | 同上（debug log に `remote=false nonInteractive=true`） |

公式ドキュメント（環境変数一覧、remote-control、MCP）に、サーバー型が作るセッションへファイル無しで MCP を渡す手段、MCP 設定を受け取る環境変数、`-p` で remote-control を有効にする手段の記述は無い。`remoteControlAtStartup` は対話型の起動時に効き、true はユーザー設定か管理者設定でのみ有効。

## 決定（技術判断）

1. desktop ↔ core は SSE + POST。出力は SSE（イベント ID = チャンク ID、つなぎ直しは `Last-Event-ID`）、入力は POST。center と同じポート・同じ token。desktop の Rust 側が受け、画面へは Tauri の event で渡す（webview は center に直接触れない、`docs/architecture.md`）。
2. core は center のプロセスの中のモジュールにする（責務は center の MCP と分ける）。center の再起動では今も master-cap を止めて `--continue` で起動し直しているので、core を別プロセスにして再起動をまたいでも得るものが無い。wrapper との間は wrapper の stdin / stdout（枠付きのメッセージ）。
3. remote-control 有効化確認への自動応答は center に残す（今のコード）。wrapper は出力の中継と入力の書き込みだけ。
4. session URL と接続状態は、wrapper が制御文字を除いた文字列を center に渡し、center が行単位ではなく直近の一定量の文字列に対して照合する（描き直しで行が割れても拾うため）。実装時に実測で確認する。
5. 再起動時の続きは対話型の `claude --continue --remote-control <name>` を使う。実装時に実測で確認する。
6. バッファの初期値: core はセッションごとに 8 MiB、desktop は 2 MiB（core を desktop の 4 倍にする）。運用で調整する。
7. wrapper の pty は Rust の `portable-pty`（WezTerm 由来、Windows は ConPTY）。先に macOS で作り、Windows は後で実機確認する。

8. セッション向けの窓口（`/mcp/session`）の認証は、center がセッション起動ごとに作る使い捨ての token にする。外向けの token では呼べない（外向けの token を持つ相手が session を名乗れないようにするため）。master-cap には環境変数で渡し、`--mcp-config` の header で `${VAR}` 展開させる。
9. 外向けには読み取り専用の `remote_list` を残す（desktop の「リモート指示タスクの一覧」の表示用）。作成・削除はセッション向けだけ。
10. 中央の列は、そのセッションが指示を送った remote-cap の記録（`remote_list` の `owners` 一致分。server の cap 単位。履歴は無く、最新の結果と未完了の指示だけ）を出す。今の Cork 形式のタスク一覧は消さず、同じ列の下に残す。
11. pty の大きさは、最後にサイズを送ってきた desktop に合わせる。
12. wrapper は `packages/pty-wrapper`（Rust crate）に置き、center と同じく desktop の sidecar として同梱する。center は自分の実行ファイルと同じ場所から wrapper を探す。

## 追加指示（system prompt への追記、2026-11-04）

desktop の設定画面で入力した「master-cap への追加指示」を、center が起動する master-cap に渡す。

13. 渡し方は claude の `--append-system-prompt <text>`。center の config の `remoteControl.sessionInstructions`（文字列、省略可、空は無し）を、session を起動するたび（新規・再起動・`--continue`・resume 失敗後の素の起動）に `buildWrapperArgs` が足す。wrapper 経由の対話型 session だけが対象。
    - 比較した案: (A) cwd に `CLAUDE.md` を書く（手で起動した claude にまで効き、ファイルの所有者も曖昧）、(B) `--append-system-prompt-file` で center の状態 dir のファイルを指す、(C) `--append-system-prompt` を argv で渡す。
    - (C) を採用。argv は center → wrapper が `child_process.spawn` の配列（shell なし）、wrapper → claude が `portable-pty` の `CommandBuilder::args`（shell なし）で、複数行・引用符・`$` はそのまま 1 引数で届く。テストで確かめた。(B) はファイルの置き場・書き込み・掃除が増えるだけで、今の長さでは得るものが無い。
    - 上限: 引数の長さ。Linux は 1 引数 128 KiB、Windows はコマンドライン全体で約 32K 文字。`--mcp-config` などと同じ command line に載るので、config で 16000 文字以内に制限する。超えて必要になったら (B) に替える。
14. 追加指示の変更は動いている session に効かせない。desktop は変更で center を再起動しない（center の停止は master-cap を止めるため、再起動すると session を自動で再起動することになる）。center は session を起動するたびに config を読み直す（決定 16）ので、保存した値は保存後に起動する session（新規・再起動・`--continue`・resume 失敗後の素の起動）から効く。
15. `rc_status` / `session_list` に `instructions`（真偽。その起動で `--append-system-prompt` を付けたか）を出す。本文は出さず、`rc_status` の `args` と起動ログでも値は `<N 文字>` に伏せる。desktop はサイドメニューの行と見出しに小さな印を出す。
16. center は wrapper 経由の session（master-cap）を起動するたび（新規・再起動・`--continue`・resume 失敗後の素の起動）に config（`center.json`）を読み直し、その時点の `remoteControl` を使う（`createRemoteControlSupervisor` の `configPath`、`loadConfigSync`）。center は再起動しない。
    - 比較した案: (A) 起動時に 1 度だけ読む（従来。保存しても center の再起動まで効かない）、(B) desktop が保存のたびに center を再起動する（master-cap の session が全部止まる。決定 2 と「自動では再起動しない」に反する）、(C) center が起動のたびに読み直す、(D) desktop から center へ「再読込」を知らせる経路を足す（center の HTTP には desktop から設定保存を知らせる route が無い。足さなくても (C) で要件を満たせるので足さない）。
    - (C) を採用。起動のたびに読めば、保存から次の起動までの間にファイルが書き換わっても取りこぼさず、通知の取りこぼし・順序の問題も無い。`launch` が同期なので読み込みは同期（`readFileSync`、小さい JSON）。
    - 読み直しに失敗した時（ファイル無し・JSON が壊れている・検証 NG）は、直前に読めた値（まだ 1 度も読めていなければ起動時の値）で起動し、理由を `center.log` に 1 行残す（`config の読み直しに失敗。直前の値で起動: project=… <理由>`。追加指示の本文は出さない）。session の起動は止めない。
    - 読み直しで効く項目（その session の起動時点の値を使う）: `remoteControl.sessionInstructions` / `model` / `env` / `autoConsent` / `maxRestarts` / `restartDelayMs` / `continueOnRestart`。再起動の予約は、その起動で読んだ値で決める。
    - 起動時にしか効かない項目（center の再起動が要る）: `remoteControl.claude`（起動時に解決する）、`remoteControl.stopGraceMs`（停止は起動と別の経路で、読み直しの対象外）、`projects` / `servers` / `logDir` / `workspace` / `token`、HTTP の port / bind。この一覧に項目を足さない（新しい `remoteControl` の項目は、session 起動時に使うなら読み直しの値を使う）。

17. 追記（2026-11-04）: context の窓は claude の statusLine の JSON（`context_window.context_window_size`）を正本にする。center は master-cap を起動する時に `--settings '{"statusLine":{"type":"command","command":"<center の status-line サブコマンド>"}}'` を足し、サブコマンドが stdin の JSON を `POST /sessions/<name>/status-line` へ送る。**利用者の statusLine 設定より center のものが master-cap で優先される**（利用者の statusLine は master-cap では出ない）。
    - 理由: transcript の model 名は `[1m]` が落ちた素の名前で窓が決められず、desktop の ctx 表示が % にならなかった（`[1m]` 無しの session で 25 万 token 使えていた）。
    - 比較した案: (A) transcript の model 名から窓を推測する（`[1m]` 無しで 1M の session があり、決められない）、(B) `/context` の出力を画面から読む（画面解析は採らない方針）、(C) statusLine の JSON を使う、で (C)。(C) の渡し方は、(C1) `/bin/sh` + `curl`（token が curl の argv に出て `ps` に見える。Windows に無い）、(C2) 一時ファイルを書く（掃除が増える）、(C3) center 自身のサブコマンド。(C3) を採用。token は claude の env `BANTOU_SESSION_TOKEN`（`--mcp-config` と同じ使い捨て）を子が読み、argv に載せない。
    - `--settings` は `statusLine` のキーだけを渡す（他の設定は上書きしない。実機で hooks・output style が残ることを確認）。
    - 値: `usedTokens` = `total_input_tokens`（output を含まない。claude の `used_percentage` と同じ式）、`percent` は出し直した小数 1 桁。statusLine の値が来るまで、および `used_percentage` が `null` の間は transcript 方式を予備にする（窓だけ statusLine で補う）。詳細は `packages/center/README.md` の「statusLine 方式」。
    - 利用者から見える副作用: statusLine を設定していなかった利用者でも、master-cap の端末では footer の hint（`esc to interrupt` など）が消える（custom statusLine を設定した時の claude の仕様。docs 記載）。Windows での実行は未検証。
    - desktop の表示は変えない（1M は「1M」）。

## 別件（同日の観測）

- server 0.3.1: `remote_create` に repo を渡すと、clone 前に `logs/center.json` が cap の dir を作るため `cap の path は git repo でない` で必ず失敗する。
- center の remote 記録は最初の `cap_result` だけが残り、worker 完了後の `cap_result`（report 起因）で更新されない。→ 修正済み（`docs/history/20261103-1210-remote-result-followup/report.md`）。
- 0.1.23 へアプリ内更新した直後の起動で、center（sidecar）だけ broker に届かなかった。同じ binary を ssh から単独起動すると届く。アプリを再起動すると直った。原因は未確定。

## 追記（2026-11-04）: remote-cap は 1 つの server につき 1 つ

- center は server ごとに remote-cap を 1 つだけ持つ（cap_id は center ごとに固定の `c-<10 桁 hex>`）。session からの指示は `remote_send`（別名 `remote_create`）でその cap への「次の指示」になり、cap が無い時だけ最初の `kick_cap` で作る。
- 記録は server の cap 単位（履歴は持たない。最新の結果と未完了の指示だけ）。完了通知は、cap が idle で worker 無しになった時に、未完了の指示を全て完了にして指示を送った session ごとに送る。
- 経路テスト時点の `remote_create`（作業ごとに cap を作る）の記述は、この変更前のもの。詳細は `docs/design/center-tools.md` と `packages/center/README.md`、`docs/history/20261104-0200-one-cap-per-server/report.md`。
