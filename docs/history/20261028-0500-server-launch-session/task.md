# 指示書: bantou-server に broker 内蔵・peer 登録・remote session 起動を実装（204）

- 日付: 2026-10-28
- 発行: main cap（Mac）
- 宛先: 204 の remote cap（tmux `wcap-bantou`、cwd `/home/vagrant/work/bantou/develop`）
- 置き場: `docs/history/20261028-0500-server-launch-session/task.md`

## お前の立場

お前は bantou の remote cap。実作業は Agent ツールのサブエージェント（worker）に委譲して統括する。実装 worker は `sonnet`、調査 worker は `opus`。`model` は毎回明示する。質問するな。迷う点は推奨案で進め、報告書に「判断した点」として残せ。worker の報告にバグがあれば別 worker を立てて補修まで自律で回せ。

## 背景（確定事項）

- リポの主は GitHub `unagents/bantou`（origin）。Gitea は読み取り専用 mirror。push は `origin develop`。
- `server/` は TypeScript の npm package `bantou`（0.1.1 公開済み）。今は config 読込・`<workspace>/repos/` 作成・常駐・SIGTERM 終了だけ。
- agent-messenger（Gitea npm `@agent-hand/*` 0.8.0、registry `http://192.168.1.202/gitea/api/packages/agent-hand/npm/`）の事実:
  - `@agent-hand/messenger-broker` が `startBroker(options)` を export。戻り値 `{close(), port, id}`。SIGINT/SIGTERM handler は張らない。options が env より優先。`port: 0` でランダム。`DISCOVERY: "off"` で UDP 発見応答を止められる。
  - `@agent-hand/messenger-client` が `createMessengerClient({env, name, summary, brokers[], autoStartBroker})` を export。メソッド: `connect, close, send(to, text, delivery), ping, listPeers, setName, setSummary, checkMessages, onMessage(handler)`。stdio・process.exit・session socket は使わない。`createBrokerClient`、`resolveBroker` も export。
  - broker HTTP API は `/register /heartbeat /set-name /set-summary /list-peers /send-message /poll-messages /acknowledge-messages /unregister /health`。受信は polling（1 秒）、heartbeat 15 秒、TTL 60 秒。
  - メッセージは `{id, from_id, from_name, to_id, text, mode(pull|push|ping), sent_at, ...}`。
  - dev checkout は Mac にしかない。204 では公開 package を使う。
- 204 では tmux と claude（`/home/vagrant/.local/bin/claude`）が使える。cap の起動方式（参考）: `tmux new -d -s <id> -c <dir> claude --permission-mode auto`。trust ダイアログは cwd が未 trust の時に出る。

## 目的

`bantou`（server）を起動すると、内部で agent-messenger broker が立ち、server 自身が peer `bantou-server` として登録され、他 peer から「remote session 起動」を指示する JSON を受けると、その host 上に claude の session（tmux）を起動して結果を返す。desktop 側は今回は作らない。指示は messenger の `send` CLI か `createBrokerClient` から送る。

## 要件

1. broker 内蔵: 起動時に `startBroker()` をプロセス内で起動。config.json に `broker: { port, bind, discovery, token }` を追加（既定 port 7901、bind 0.0.0.0、discovery "on"、token 無し）。終了時に `close()`。
2. peer 登録: `createMessengerClient` で自分の broker に接続し、name `bantou-server`、summary に host 名と workspace を入れる。`onMessage` で受信。`brokers` には内蔵 broker の URL を明示し、UDP 発見に頼らない。
3. 指示の受理: text が JSON で `{"bantou":1,"type":"launch_session", ...}` の時だけ処理。それ以外（非 JSON、`type` 不明）は無視してログ。型は `packages/protocol` に追加する（`ServerCommand` / `ServerReply`、型ガード付き）。最低限:
   - `launch_session`: `{ "name": "<英数-_>", "repo"?: "<git url>", "branch"?: "<branch>", "cwd"?: "<repos 配下の相対パス>" }`。`repo` があれば `<workspace>/repos/<name>` に clone（既にあれば `git fetch` のみ）。`cwd` 省略時は `<workspace>/repos/<name>`（repo 無しなら mkdir）。tmux session `<name>`（既存なら起動しない）を cwd で作り、`claude --permission-mode auto` を起動。
   - 返信: 送信元（`from_id`）へ `{"bantou":1,"type":"session_launched","name":...,"tmux":...,"cwd":...,"ok":true}` または `{"type":"error","message":...}` を `send` で返す。
   - `list_sessions`: `tmux ls` 相当の一覧を返す（最小実装でよい）。
4. session の起動コマンドは config の `session.command`（既定 `claude --permission-mode auto`）で差し替え可能にする。tmux が無い環境ではエラー返信。
5. ログは既存の形式（`<ISO> bantou: ...`）に揃える。
6. テスト:
   - unit（node:test）: 指示 JSON の parse と型ガード、name の文字種検証。
   - e2e（スクリプト、`server/scripts/e2e-launch.sh` か ts）: 一時 workspace と一時 config（`broker.port` はランダム or 17901、`discovery: "off"` で LAN の本番 broker に影響させない）で server を起動 → `createBrokerClient` または `npx -y @agent-hand/messenger send` 相当で `launch_session` を送る → tmux session が出来て `capture-pane` に claude のプロンプト（`❯`）か trust ダイアログが出ることを確認 → `list_sessions` の返信を確認 → tmux session を kill → server に SIGTERM → exit 0 と broker 停止を確認。一時物は削除。
   - e2e は 204 で実際に通すこと（`claudeAgent` で実行。`/home/vagrant/work/bantou/` 配下に一時 workspace）。
7. `server/README.md` を更新: 内蔵 broker、peer 名、指示 JSON の形、返信の形、config.json の全項目、e2e の実行方法。
8. 依存の解決: `server/.npmrc` に `@agent-hand:registry=http://192.168.1.202/gitea/api/packages/agent-hand/npm/` を置く。これにより npmjs へ publish した `bantou` は LAN 外で install できなくなる。この事実を README の注意として書き、報告書にも「npmjs 公開は messenger package の公開が前提」と明記。今回は publish しない。
9. commit は英語の通常文、develop に push（`origin` = GitHub。`claudeAgent` の gitconfig に GitHub 用 helper 設定済み）。

## 禁止

- `desktop/`、`docs/`（history 除く）、`plugin/`、`Casks` の変更。
- LAN の本番 broker（`192.168.1.202:7901`）やこの Mac の broker への登録・送信。テストは常に内蔵 broker（discovery off、別 port）を使う。
- 本番 port 7901 で discovery "on" のまま e2e を走らせること。
- sudo を要する操作、systemd 登録、/etc への書込、python。
- ユーザーへの質問。

## 完了条件

- `cd server && npm run typecheck && npm run build && npm test` が通る。
- e2e が 204 で通り、ログ抜粋（起動、broker port、peer 登録、受信した指示、tmux 作成、返信、SIGTERM 終了）が報告書にある。
- `packages/protocol` の typecheck / build / test が通る。
- develop に push 済み。

## 報告

- パス: `docs/history/20261028-0500-server-launch-session/report.md`（commit して push）
- 必須: 作成・変更ファイル一覧、各コマンドの結果要約、e2e のログ抜粋、commit hash、push 結果、判断した点、範囲外で見つけた問題。
- 報告書を push したら、次の指示があるまで待機。
