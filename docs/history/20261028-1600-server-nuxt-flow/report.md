# 報告書: server の設計更新・Nuxt 化・worker 報告の受け口（204）

- 日付: 2026-10-28 / 作成: 204 remote cap `wcap-bantou`
- 指示書: 同 dir の `task.md`（新版）。旧 spawn_worker / worker_report 案は revert 済みで、この報告書には載せない。
- worker: sonnet（実装）、opus（調査）

## commit

| commit | 内容 |
|---|---|
| `87a968a` | 段階 1: server を Nuxt 4（Nitro）に移植（機能は現状維持） |
| `ec2dd33` | 旧設計（d14d528 / 7184fa4 / 37a6d64）の revert |
| `258d47a` | 新 task.md |
| `efd1672` | 段階 0: `docs/architecture.md` の「server の実行モデル」を書き換え |
| `788cb3d` | 段階 1: server から `resume_worker` の処理を削除 |
| `5ab79b6` | 段階 2: `/mcp` の受け口、listener、report の記録、cap の resume、結果の返信、e2e、計測 script、docs |
| 本報告書 | 別 commit |

## 旧設計の revert（ec2dd33）

- 旧設計は server が worker を起動する方式（`spawn_worker` / `worker_report`、messenger 経由）だった。
- 新設計では server は worker を起動せず、worker は cap の責務になる。worker は MCP（HTTP）で server に報告する。
- d14d528・7184fa4・37a6d64（旧 task / report を含む）を `git revert` で 1 commit にまとめて取り消した。履歴の書き換えはしていない。87a968a の Nuxt 化は採用して土台にした。

## 段階 0: 設計の文書化（efd1672）

- `docs/architecture.md` の「server の実行モデル」を確定設計に書き換えた。server の責務は 3 つ、worker は cap の責務、worker → server は MCP、server → cap は resume、cap → center は messenger。
- 旧 `resume_worker` / `spawn_worker` 案は削除した。
- 「未決」節の center と server の連携は「protocol 方式（agent-messenger 0.10.0）への移行時期。それまでは現行の messenger 直接送信」に変えた。

## 段階 1: Nuxt 化（87a968a / 788cb3d）

- `server/` を Nuxt 4（Nitro、UI なし、preset `node-listener`）にした。nuxt は `~4.5.2`。
- 構成は stroke に合わせた。`server/server/utils/bantou/*.ts` が純関数群、`server/server/plugins/01.bantou.ts` が起動・signal・exit を担う。`bin/bantou.mjs` が `--config` を解釈して `.output/server/index.mjs` を import する。
- 現行機能（内蔵 broker、peer 登録、`kick_cap`、state.json、孤児回収、retry、`session.env`、SIGTERM 終了、ログ形式）を移植した。
- `resume_worker` は 788cb3d で server から削除した。受けた場合は `error`（"resume_worker は未対応"）を返す。
- 結果: typecheck・build 成功。unit 76 pass / 0 fail。e2e は `E2E OK`（kick_cap new → 同じ session_id で resume → status → 非コマンド無視 → SIGTERM exit 0）。

### npx 起動の実測

- `npm pack` で `bantou-0.1.1.tgz` ができた（1.0 MB / 242 files、`.output` を含む）。一時 dir に install し、`npx bantou --config` で起動した。
- 起動ログ:

```
bantou: 起動
bantou: 孤児回収: killed=0 failed=0 error=0
[agent-messenger broker] v0.9.0 id=proA1989 listening on 127.0.0.1:46813
bantou: broker 起動: port=46813 bind=127.0.0.1 discovery=off token=無 id=proA1989
bantou: peer 登録: name=bantou-server id=tzojkzue broker=http://127.0.0.1:46813
bantou: 常駐開始
```

- SIGTERM の後は `SIGTERM 受信、終了処理` → `Unregistered from broker` → `broker 停止` → `終了` と出た。
- 終了コード:
  - daemon の node プロセスに直接 SIGTERM を送ると、npx は exit 0。
  - `timeout` 経由で npx に送ると exit 143（npm exec が signal を伝播するため）。
  - `--bad` は usage を出して exit 2。相対 workspace は fatal ログを出して exit 1。
- 段階 1 の時点で Nitro 自体は listen しない（port を持たない）。

## 段階 2: worker 報告の受け口（5ab79b6）

### 実装

- MCP は `server/server/routes/mcp.ts` と `utils/bantou/mcp.ts`。
  - `@modelcontextprotocol/sdk` 1.32.2 の `McpServer` と `WebStandardStreamableHTTPServerTransport` を使う。stateless で `enableJsonResponse`。
  - tool は `report`（`kind: progress|ask|approve|done`、`text`）。
  - header `x-bantou-cap-id` / `x-bantou-worker-id` で送信元を判定し、すぐ `accepted` を返す。
- listener:
  - preset は `node-listener` のまま。plugin が `http.createServer(toNodeListener(nitro.h3App)).listen({host, port})` を立て、`server.address().port` から実 port を取る。
  - daemon が所有し、SIGTERM の終了処理で閉じる。ログは `mcp 起動: url=…` / `mcp 停止`。
- config に `mcp: { port, bind }` を追加した。既定は `7902` / `127.0.0.1`。port 0 は e2e だけで使う。
- report の流れは `utils/bantou/reports.ts`。
  - report を `logs/reports.jsonl` に追記し、該当 cap の既存 queue（`manager.invoke`）に積んで `--resume` する。
  - resume の prompt は `worker <id> から <kind>: <text>` に、worker へ返す時の MCP 情報（URL・header 名）を添える。
- center への返信:
  - `kick_cap` の送信元 center（`from_id`）を cap ごとに `logs/center.json` へ保存する。再起動後も復元する。
  - cap の結果（report 起因の resume を含む）を、その center へ `cap_result` で返す。
  - resume 失敗は `error`（`command: "kick_cap"`、`cap_id`）。center 不明ならログのみ。
- 依存の `@modelcontextprotocol/sdk` と `zod` は devDependencies に置いた。Nitro が `.output` に取り込む。
- 結果: typecheck・build 成功。unit 90 pass / 0 fail（新規 14）。

### e2e（204、実 claude）

- 構成:
  - 内蔵 broker は port 0 / 127.0.0.1 / discovery off。`/mcp` も port 0。
  - `session.env` で `CLAUDE_CONFIG_DIR=/home/vagrant/.claude-agent` を渡した。
  - cap と worker は `--model sonnet`。
- cap への指示:
  - worker を `setsid claude -p … </dev/null >log 2>&1 &` で 1 つ起動させた。
  - worker の `--mcp-config` には server の MCP（http、URL と header）を入れ、`--strict-mcp-config --allowedTools mcp__bantou__report` を付けた。
  - worker には `echo hi` を実行させ、`report` done で報告させた。
- 結果は最終 run で `E2E OK`。
  - kick_cap（new / resume）、worker 報告、status、非コマンドの無視、SIGTERM を確認した。
  - SIGTERM では exit 0、`mcp 停止` / `broker 停止` / `終了` が出て、port も解放された。
  - worker 報告の所要は約 18〜20 秒。
- 流れのログ抜粋（最終 run）:

```
mcp 起動: url=http://127.0.0.1:36983/mcp bind=127.0.0.1
指示受信: type=kick_cap ... cap_id=e2e-cap-1816991-w reason=e2e worker prompt=You are a cap. ...
claude 起動: kind=cap id=e2e-cap-1816991-w mode=new session=872aa77c-...
claude 終了: ... ok=true ms=10530 retries=0
返信: to=qp1xl2u4 type=cap_result
report 受信: cap_id=e2e-cap-1816991-w worker_id=w1 kind=done text=worker finished: hi
claude 起動: kind=cap id=e2e-cap-1816991-w mode=resume session=872aa77c-...
claude 終了: ... ok=true ms=3117 retries=0
返信: to=qp1xl2u4 type=cap_result (report 起因) cap_id=e2e-cap-1816991-w
```

- resume された cap は `WORKER_REPORT done worker finished: hi` と返し、同じ session_id の結果が kick_cap の送信元に届いた。
- 本番 broker に繋がっていないことの確認（e2e script が自動で検査）:

```
[e2e] worker init mcp_servers=[{"name":"bantou","status":"connected","source":"dynamic"}]
[e2e] cap init (872aa77c-....jsonl) mcp_servers=[]
```

  - server に渡す env から `AGENT_MESSENGER_*` / `CLAUDE_CODE_MESSAGING_*` を除いた。cap と worker は `--strict-mcp-config` で起動した。

### sandbox と実行環境

- e2e の 1 回目は sandbox 内（allowed_domains: api.anthropic.com, registry.npmjs.org）で試した。
  - api には繋がったが、resume が「session が無いので新規に切り替え」になって失敗した。
  - 原因は `~/.claude-agent/projects` への書き込みが sandbox で拒否されることと見ている。
  - このため、実 claude の e2e と計測は sandbox を外して実行した。段階 1 の e2e も同じ。
- `npm install` も sandbox 内では `~/.npm/_cacache` が read-only で失敗した。`--cache` を別 dir にし、registry.npmjs.org を許可して実行した。
- 既定 model（opus）は usage 上限（`out_of_credits`）で拒否された。このため `--model sonnet`（`E2E_MODEL`）で実行した。
- 引数の順序:
  - `--allowedTools` と `--mcp-config` は可変長引数で、後ろに置いた prompt を飲み込む（`Input must be provided ... --print`）。
  - このため prompt を先に置く。

## 段階 2 の 8: cap 終了後に cap の子プロセスが残るか（実測）

- 測り方:
  - `server/scripts/probe-survival.ts` から、server の kick_cap 経由で cap に Bash で probe を起動させた。
  - setsid 無しは `bash -c 'exec -a bantou-probe-plain sleep 600' … &`、有りは同じものに `setsid` を付けた（`bantou-probe-setsid`）。
  - cap 終了後に `pgrep` で残存を見た。cap の所要は約 9〜14 秒で、詰まりは無かった。

| cap の Bash sandbox | setsid 無し | setsid 有り |
|---|---|---|
| 有効（204 の既定。`~/.claude-agent/settings.json` に `sandbox.enabled: true`） | cap 終了後に消えた | cap 終了後に消えた |
| 無効（`--settings '{"sandbox":{"enabled":false}}'`） | 残った | 残った |

- sandbox 有効時:
  - cap 内から見た probe は pid 3 / ppid 2 / sid 0 だった。
  - pid namespace ごと消えるので、`setsid` を付けても残らない。
- sandbox 無効時の ps:

```
1811809  1 1811809 1811808 bantou-probe-plain 600
1811817  1 1811817 1811817 bantou-probe-setsid 600
```

  - setsid 有りは sid が自身になる。無しは cap の Bash shell の sid のまま。
- server の SIGTERM 経路（sandbox 無効で計測）:
  - cap 実行中に server へ SIGTERM を送ると、cap は SIGKILL され `server 終了により中断` で終わった。
  - server は約 6 秒で exit 0。probe は 2 つとも残った（ppid 1）。
  - sandbox 有効側は、cap が先に終わって実行中の計測ができていない。
- `setsid` 付きの `$!` は `ps` で行が出なかった。setsid が fork して親が先に終わるため。生存は外から確認した。
- 結論:
  - worker を cap の外で生かすには、`setsid` の前に cap の Bash sandbox を外す必要がある。
  - e2e は既定で外す（`E2E_NO_BASH_SANDBOX=0` で外さない）。README に外し方の例を書いた。

## 段階 3: protocol 方式（着手せず）

- agent-messenger 0.10.0 は使える状態にない。
  - npm の `@unagents/messenger` / `-client` / `-broker` は `0.0.0-stage` と `0.9.0` のみ。
  - GitHub の `feature/protocol` は docs のみ（head 6ed1131）。最新 tag は v0.9.0。
  - ローカルの wt-protocol には remote に無い型と broker の commit があり、client 側は未 commit の作業途中。設計書は「設計のみ（未実装）」。
- 条件を満たさないため段階 3 は着手せず、`protocol.json` も作っていない。

## 判断した点

- 旧段階 2 は revert で取り消した（上書きでなく）。履歴を残し、87a968a を土台にするため。
- `resume_worker`:
  - server は無視せず `error` を返す。center の `worker_resume` が返事を待ち続けないようにするため。
  - protocol の `ResumeWorkerCommand` / `WorkerResultReply` の型は残した。packages/center が使っていて、center の変更は禁止のため。
- Nitro の preset は `node-listener`。
  - node-server は port 0 が使えず、独自の SIGTERM ハンドラが二重になる。
  - `/mcp` は plugin が自前の http listener で受ける。
- config `mcp.port` の既定は固定 `7902`。
  - worker は cap より長く生き、起動時に URL を受け取るため、server 再起動で port が変わると report が届かなくなる。
  - port 0 は e2e のみ。
- MCP は SDK を直接使い、`@nuxtjs/mcp-toolkit` は採用しなかった。依存が少なく、headless で確実に動くため。
  - リクエストごとに McpServer を作る（stateless）。
- center（from_id）と report の記録は `state.json` でなく、cap の `logs/center.json` / `logs/reports.jsonl` に置いた。
  - agents.ts が state.json を丸ごと書き換えるため、別経路から書くと競合する。
  - `logs/` は clone 時に `.git/info/exclude` に入る。
- report 起因の resume の prompt には MCP の URL と header 名を添えた。
  - `--mcp-config` は resume のたびに渡し直す必要があり、`--append-system-prompt` は new の時しか効かないため。
- 計測 script `probe-survival.ts` は再実測用に repo に置いた。
  - pgrep / pkill のパターンは自分のコマンド行に一致しない正規表現にした。
- 段階 1 の判断:
  - `postinstall: nuxt prepare` を外した。利用者の npx install では devDependencies が無く失敗するため。`nuxt prepare` は typecheck 内で呼ぶ。
  - `tsconfig.json` は `.nuxt/tsconfig.server.json` を extends し、`noUncheckedIndexedAccess:false` にした。移植したコードを変えずに済ませるため。
  - `e2e` script は先に `nuxt build` する。build 済みの出力を起動するため。
  - runtime の `dependencies` は空にした。依存は Nitro が `.output` に同梱する。

## 未解決

- `server/package-lock.json` は未 commit。server/ には以前 lockfile が無く、root は `bun.lock` のため。
- tarball に `.map` と `.output/public`（Nuxt の client build、約 150 kB）が含まれる。
- 次の項目は center 側の判断待ちで残っている。
  - `workers/` dir、worker の AgentKind、status の workers 配列。
  - protocol README と center docs の `worker_resume` / `worker_result` の記述。
- 本番で cap の Bash sandbox をどうするか（`session.extraArgs` で外す等）。
- report に認証が無い。`mcp.bind` を loopback 以外にすると誰でも report できる。
- 連続した report は件数分だけ resume が走る（まとめる処理は無い）。
- 一時物の残り: `rm` が permission で拒否され、`/tmp/claude-1002` 直下に次が残っている。
  - `nx`, `nx2`, `packtest`, `npmcache`, `npmcache-a`, `npmc`
  - `bantou-npx-a`, `bantou-prb-e0R8Ve`
  - `bantou-e2e-O5Q761`, `bantou-e2e-UIkD5y`, `bantou-e2e-ZC1azN`, `bantou-e2e-kMFZVn`
  - `gate`, `w`
  - `e2e-a.log`, `e2e-b.log`, `e2e-b2-sandbox.log`, `e2e-b2.log`〜`e2e-b8.log`, `probe-b1.log`〜`probe-b4.log`
  - `server-nuxt-brief.md`, `stage1-report.md`, `rc2-research.md`
  - `~/.claude-agent/projects/` 配下にも各 run の session 記録が残る。
- 今回の作業と無関係の常駐 `bantou` が動いている。止めていない。
  - pid 1564597 / 1564699。
  - コマンドは `~/.npm/_npx/.../bantou --config /home/vagrant/work/bantou-npx-smoke/config.json`。
  - 起動は 2026-10-27 19:34。

## 追加指示: cap の Bash sandbox を既定で外す（6311fdd）

- 決定（ユーザー）: server が起動する cap は、Bash の sandbox を外して動かす。worker 側は対象外。
- 理由: 段階 2 の 8 の実測のとおり、204 の既定（`sandbox.enabled: true`）では、cap の Bash が起動した worker は setsid を付けても cap と一緒に終わるため。
- 実装:
  - config に `session.capBashSandbox`（boolean、既定 false）を追加した。boolean 以外は起動時に拒否する。
  - false の時は、cap の新規・resume とも `--settings {"sandbox":{"enabled":false}}` を付ける。true の時は付けない（従来どおり）。
- 引数の位置:
  - `--permission-mode` と `--allowedTools` / `--disallowedTools` の後ろに置く。
  - `session.extraArgs`、`--session-id|--resume <id>`、`--` より前に置く。
  - JSON に空白が無いので、孤児回収の `matchesSession` には影響しない。
  - `extraArgs` に `--settings` を重ねた場合は、後ろの `extraArgs` が勝つ想定。実機では未検証。
- e2e / probe:
  - e2e 専用の `E2E_NO_BASH_SANDBOX` を廃止した。e2e は server の既定設定で動く。
  - probe-survival は `E2E_CAP_BASH_SANDBOX=1` を付けると、sandbox を有効にしたまま計測する。
- 文書: `server/README.md`（config 表・例・根拠）と `docs/architecture.md`（実行モデルの項目 9）を更新した。
- 検証:
  - unit は 95 / 95 pass。typecheck と build は OK。
  - cap の argv に、新規・resume とも `--settings {"sandbox":{"enabled":false}}` が付くことを `ps` で確認した。
- e2e は未完了。
  - sandbox 内の実行は、resume で session が保存されておらず NG だった（`session が無いので新規に切り替え`、既知の環境差）。
  - sandbox 外での再実行は権限ゲートに拒否されたため、まだ行っていない。
  - worker report フローの完走と、init `mcp_servers` の安全確認は未確認。
