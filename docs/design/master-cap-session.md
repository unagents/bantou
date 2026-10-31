# master-cap セッションの起動と出力配信（設計、2026-11-01）

前提は `docs/concept.md`。center の tool 仕様は `docs/design/center-tools.md`。本書はユーザーと合意した方針と、その根拠になった実測をまとめる。未実装。

## 背景（経路テストの結果）

2026-11-01 に全区間の経路テストを行った（mac200、bantou 0.1.23、claude 2.1.312）。

| 区間 | 結果 | 根拠 |
|---|---|---|
| center に session 作成（`session_create`） | 通過 | `pm-route` が `connected` |
| center が master-cap を起動 | 通過 | `claude remote-control --name pm-route` が center の子として起動 |
| 番頭 → master-cap の指示 | 失敗 | desktop の「タスク追加を指示」は agent-messenger で session 名宛てに送るが、master-cap は messenger の peer でない |
| master-cap → center の `remote_create` | 失敗 | master-cap の MCP 設定に center が無い（`claude mcp list` で確認）。起動引数にも無い |
| center → server（agent-messenger） | 通過 | アプリ再起動後。更新直後の起動では center だけ broker に届かなかった（下の「別件」） |
| server → remote-cap → worker | 通過 | 起点は Mac main cap の curl（master-cap ではない） |

あわせて、center の MCP が token 1 本で全 tool を公開しており、token を持つ誰でも remote-cap を作れることが分かった（owner は自己申告）。

## 合意した方針

### 1. tool の窓口を分ける

- 外向け（desktop など token を持つ相手）: `session_create` / `session_delete` / `session_list`。
- center が起動したセッション（master-cap）向け: `remote_create` / `remote_delete` / `remote_list`。
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
10. 中央の列は、そのセッションの remote 記録（`remote_list` の owner 一致分）を出す。今の Cork 形式のタスク一覧は消さず、同じ列の下に残す。
11. pty の大きさは、最後にサイズを送ってきた desktop に合わせる。
12. wrapper は `packages/pty-wrapper`（Rust crate）に置き、center と同じく desktop の sidecar として同梱する。center は自分の実行ファイルと同じ場所から wrapper を探す。

## 別件（同日の観測）

- server 0.3.1: `remote_create` に repo を渡すと、clone 前に `logs/center.json` が cap の dir を作るため `cap の path は git repo でない` で必ず失敗する。
- center の remote 記録は最初の `cap_result` だけが残り、worker 完了後の `cap_result`（report 起因）で更新されない。
- 0.1.23 へアプリ内更新した直後の起動で、center（sidecar）だけ broker に届かなかった。同じ binary を ssh から単独起動すると届く。アプリを再起動すると直った。原因は未確定。
