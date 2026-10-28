# 報告書: server の Nuxt（Nitro）化と cap / worker 連携（204）

- 日付: 2026-10-28 / 作成: 204 remote cap `wcap-bantou`
- worker: 段階 1 = worker A、段階 2 と本報告 = worker B（調査 = opus、実装 = sonnet）
- 指示書: `task.md`。main には触っていない。

## commit

| commit | 内容 |
|---|---|
| `87a968a` | 段階 1: server を Nuxt 4（Nitro）化。機能は現状維持 |
| `d14d528` | protocol に `spawn_worker` / `worker_report` を追加 |
| `7184fa4` | 段階 2: messenger MCP 注入、spawn_worker / worker_report の処理、unit / e2e |
| 後続 | docs（README / protocol.md / architecture.md）、task.md、本報告書 |

## 段階 1: Nuxt 化（`87a968a`）

- `server/src/*` を `server/server/utils/bantou/*.ts`（Nitro 非依存の純 TS）へ `git mv`。`cli.ts` は `bin/bantou.mjs`、起動・signal・exit は `server/plugins/01.bantou.ts`。`daemon.ts` は `startDaemon(configPath)` が `Daemon{ stop() }` を返す形にした。broker・peer・指示・ログ行は不変。
- `nuxt.config.ts`: preset `node-listener`、`ssr: false`、`pages: false`、runtimeConfig `bantou.configPath`。
- package.json: `bin` は `bin/bantou.mjs`、`files` は `["bin", ".output"]`、`prepack: nuxt build`、runtime `dependencies` は空（全て devDependencies）、nuxt `~4.5.2`。
- 結果: typecheck 0 error、build 成功（`.output/server/node_modules/@unagents/messenger-{broker,client,protocol}` が trace される。`@agent-hand/bantou-protocol` は chunk に inline）、unit 76 pass / 0 fail、e2e OK。

### npx 起動の実測

```
cd server && npm pack --pack-destination $M/pack
  -> bantou-0.1.1.tgz  package size 1.0 MB, unpacked 4.1 MB, 242 files, .output/** 同梱
cd $M/inst && npm init -y && npm install $M/pack/bantou-0.1.1.tgz   -> "added 1 package"
npx bantou --config $M/config.json
```

config: `{"workspace":"$M/ws","broker":{"port":0,"bind":"127.0.0.1","discovery":"off","token":""}}`

```
2026-10-28T01:36:58.295Z bantou: 起動
... bantou: 孤児回収: killed=0 failed=0 error=0
[agent-messenger broker] v0.9.0 id=proA1989 listening on 127.0.0.1:46813
... bantou: broker 起動: port=46813 bind=127.0.0.1 discovery=off token=無 id=proA1989
... bantou: peer 登録: name=bantou-server id=tzojkzue broker=http://127.0.0.1:46813
... bantou: 常駐開始
```

- Nitro 自身の listen は無し（`ss -tlnp | grep node`。ただし確認は daemon 終了後に 1 回のみで、稼働中の同時確認はしていない）。
- SIGTERM: `timeout --preserve-status -s TERM 4 npx bantou ...` でログに SIGTERM 受信 / Unregistered / broker 停止 / 終了。timeout + npx の終了コードは 143（npm exec が signal を伝播）。bin 直接の SIGINT は exit 0。daemon の node プロセスへ直接 SIGTERM すると npx は exit 0。
- `npx bantou --bad` は usage で exit 2。相対 workspace の config は fatal ログで exit 1。

## 段階 2: cap / worker 連携（`d14d528`, `7184fa4`）

### 実装

- protocol（`packages/protocol/src/server.ts`）: `SpawnWorkerCommand`、`WorkerReportCommand`、guard（`isSpawnWorkerCommand` / `isWorkerReportCommand`、`isServerCommand` の拡張）。protocol test 16 pass。
- `server/utils/bantou/messenger.ts`（新規）: `--mcp-config` の JSON、system prompt、注入引数、子 env の整理（継承 `AGENT_MESSENGER_*` / `CLAUDE_CODE_MESSAGING_*` を除去）。
- `links.ts`（新規）: `workers/<id>/owner.json`（`{cap_id}`）、`caps/<id>/reply_to.json`（`{id, name}`）の原子的な書き込みと読み取り。
- `flow.ts`（新規）: `spawn_worker`（worker を背景起動）、`worker_report`（owner の cap を resume、終了後 `cap_result` を `reply_to.json` の peer へ）、worker 失敗時の cap 再開。
- `agents.ts`: `InvokeInput.sidecar`（dir 準備後・起動前に JSON を書く）、`broker` getter（あれば注入）、`allowedTools` へ `mcp__bantou-messenger__send_message` を追加、clone 時の `.git/info/exclude` に `owner.json` / `reply_to.json`。
- `claude.ts`: `injectArgs`（`--session-id|--resume <id>` の後ろ、`--` の前）。
- `config.ts`: `messenger.command` / `args` / `env`（既定 `npx -y @unagents/messenger@0.9.0 mcp`）。
- `daemon.ts`: broker 起動後に接続情報を manager へ渡す。`kick_cap` の送り主を `reply_to.json` に保存。`spawn_worker` は返信なし、`worker_report` は owner 不明時のみ `error` 返信。
- `scripts/e2e-launch.ts`: 外部 kick → spawn_worker → worker_report → cap 再開の流れを追加。`CLAUDE_CONFIG_DIR` は config の `session.env` で渡す。

### 検証結果

| 項目 | 結果 |
|---|---|
| `npm run typecheck`（server） | 0 error |
| `npm run build`（server） | 成功 |
| `npm test`（server unit） | 97 pass / 0 fail（段階 1 は 76。+21: messenger 6、flow 7、agents 3、claude 1、config 1、daemon 3 など） |
| `npm test`（packages/protocol） | 16 pass / 0 fail |
| `npm run e2e` | E2E OK（実 claude 6 回起動） |

### HARD GATE（本番 broker 遮断）の結果

テスト用 broker（port 0、127.0.0.1、discovery off、token 無）を立て、`CLAUDE_CONFIG_DIR=/home/vagrant/.claude-agent` のまま、注入設定で実 `claude -p --output-format stream-json --verbose` を 1 回起動した。system/init の `mcp_servers`:

```
INIT mcp_servers: [{"name":"bantou-messenger","status":"connected","source":"dynamic"}]
tools_mcp: mcp__bantou-messenger__{check_messages,list_peers,send_message,send_ping,set_name,set_summary}
RESULT success false "ok"
```

- plugin の `agent-messenger`（本番 broker 向け）は `mcp_servers` に現れなかった。`--strict-mcp-config` が効いている。ブロッカー無し。
- 初回は `bantou-messenger` が `failed` だった。原因は MCP loader が platform client を `~/.agent-messenger/pkgs` に入れようとして sandbox で ENOENT になったため。MCP env に `AGENT_MESSENGER_PKGS_DIR`（workspace 配下）を足して解消し、2 回目で `connected`。
- `AGENT_MESSENGER_BROKER_CMD=false`: port を閉じた値（1）にして起動 → `bantou-messenger` は `failed`、実行後の `ps` に messenger / broker プロセスなし。確認は sandbox 内で行ったため、sandbox 終了時の掃除で見えなくなった可能性は排除できていない（`BROKER_CMD=false` が効いた直接の証拠は「`failed` で即時終了した」まで）。
- 空文字 env（`CLAUDE_CODE_MESSAGING_SOCKET` / `TOKEN`）による打ち消しは、init が本番 plugin を含まず `connected` だった結果と矛盾しない。個別の効果の切り分けまではしていない。

### e2e のログ抜粋（実 claude、`CLAUDE_CONFIG_DIR=/home/vagrant/.claude-agent`、broker port 0 / 127.0.0.1 / discovery off）

flow 部分（cap `e2e-flowcap-*` → worker `e2e-flowworker-*`）:

```
指示受信: type=kick_cap from=bantou-e2e-sender(vfenkrvv) cap_id=e2e-flowcap-1770538 reason=e2e flow prompt=Spawn exactly one worker. ...
claude 起動: kind=cap id=e2e-flowcap-1770538 mode=new session=86a259a4-...
指示受信: type=spawn_worker from=bantou-cap-e2e-flowcap-1770538(n7bktnag) worker_id=e2e-flowworker-1770538 cap_id=e2e-flowcap-1770538 prompt=Run `echo hi` in Bash. Then send a worker_report ...
claude 起動: kind=worker id=e2e-flowworker-1770538 mode=new session=e6e6fa03-...
claude 終了: kind=cap id=e2e-flowcap-1770538 session=86a259a4-... ok=true ms=9712 retries=0
返信: to=vfenkrvv type=cap_result                                  <- 1 回目（cap は spawn して終了）
指示受信: type=worker_report from=bantou-worker-e2e-flowworker-1770538(bmvvjnit) worker_id=e2e-flowworker-1770538 kind=done text=hi
claude 起動: kind=cap id=e2e-flowcap-1770538 mode=resume session=86a259a4-...   <- 同じ session を resume
claude 終了: kind=worker id=e2e-flowworker-1770538 ... ok=true ms=10543
claude 終了: kind=cap id=e2e-flowcap-1770538 session=86a259a4-... ok=true ms=4607
返信: to=vfenkrvv type=cap_result                                  <- 2 回目（resume 後の cap の完了）
```

- 2 回目の `cap_result` の `result_text` に `hi` が含まれることを e2e が検証（`REPORT=<text>` 形式で返させた）。`workers/<id>/owner.json` の `cap_id` も検証。
- 同じ e2e の既存部分（kick_cap new → resume、resume_worker、status、非 command 無視、SIGTERM exit 0、port 解放）も通過。
- 注: `resume_worker` で起動しただけの worker `e2e-worker-*` も注入された MCP で `worker_report`（text=pong）を自発的に送り、owner 不明のため server が `error` を返した（`エラー: worker_report: ... 所有 cap が不明`）。e2e は成功、動作は仕様通り。

### sandbox の扱い

- gate と unit は sandbox 内で実行（`allowed_domains`: api.anthropic.com、registry.npmjs.org）。gate は sandbox 内で成功。
- e2e は sandbox 内で 1 回実行し失敗: 2 回目の `kick_cap`（resume）で `session が無いので新規に切り替え: ... old=fd23e25e-...` となり session_id が変わった。`/home/vagrant/.claude-agent/projects` が sandbox で書込拒否のため session が保存されない（段階 1 でも同じ症状）。この証拠に基づき、e2e のみ `dangerouslyDisableSandbox` で再実行して `E2E OK`。他のコマンドは sandbox 内。

## docs

- `server/README.md`: 指示表、`messenger` config、workspace レイアウト（`owner.json` / `reply_to.json` / `.npm-cache` / `.messenger-pkgs`）、「cap / worker 連携」節、e2e の説明。
- `docs/protocol.md`: `spawn_worker` / `worker_report`、cap_result の追加送信、storage、MCP 注入の節。
- `docs/architecture.md`: Nuxt 化後の構成、実行モデルの 4〜9、未決の更新。`server/src` への参照は docs 内に残っていないことを grep で確認。

## 判断した点

### cap が確定した方針（ブリーフ。再検討していない）

- messenger-nuxt は使わない。`startBroker` + `createMessengerClient` を 1 つの Nitro plugin で async 直列に包む。
- Nitro preset は `node-listener`（listen しない、port を掴まない）。`ssr: false`、`pages: false`。
- SIGTERM / SIGINT は bantou plugin が自前で `process.on`。現行 shutdown（5 秒 hard timeout、exit 0）+ `nitro.hooks.callHook('close')`。
- 起動失敗は plugin 内で fatal ログ + `process.exit(1)`。
- config: bin wrapper が `--config <path>` を解釈（既定は実行時 homedir から計算）し `NUXT_BANTOU_CONFIG_PATH` に入れる。plugin は `useRuntimeConfig().bantou.configPath` を既存 `loadConfig()` へ。config JSON 全体を env に入れる案は却下（token が子プロセス env に漏れる）。
- テストは `node --import tsx --test` を据え置く（utils は Nitro 非依存の純 TS）。
- worker→cap の対応は state.json ではなく別ファイル `workers/<id>/owner.json`（state.json は書くたびに全体を作り直すため）。
- `kick_cap` の送り主を `caps/<id>/reply_to.json` に残し、resume 後の cap 終了でも `cap_result` を送る。
- `--session-id` / `--resume <id>` は注入フラグより前に置く。system prompt に `" -- "` を入れない（孤児回収 `matchesSession` が最初の `" -- "` で切る）。
- MCP 注入: `--mcp-config <json>` + `--strict-mcp-config` + `--allowedTools mcp__bantou-messenger__send_message` + `--append-system-prompt`（new で必ず渡し、id ごとに固定）。MCP server key は `bantou-messenger`。継承 `AGENT_MESSENGER_*` / `CLAUDE_CODE_MESSAGING_*` は子 env から除く。MCP の command / args は config で差し替え可能（既定 npx）。MCP env に書き込める `npm_config_cache`。

### 段階 1 の判断（worker A）

- postinstall の `nuxt prepare` を外した（利用者の npx install で devDependencies が無く失敗するため）。`nuxt prepare` は typecheck 内で呼ぶ。
- `tsconfig.json` は `.nuxt/tsconfig.server.json` を extends、`server` / `test` / `scripts` を include、`noUncheckedIndexedAccess: false`（移動したコードを変えずに済ませるため。Nuxt 既定だと約 10 エラー）。
- e2e script は `nuxt build && node --import tsx scripts/e2e-launch.ts`（build 済みの出力を spawn）。
- `bin/bantou.mjs` は `--config` を `resolve()`、top-level await で import。usage エラーは exit 2 のまま。

### 段階 2 で私が決めた点

- `spawn_worker` は成功時も返信しない。cap は返信を待たず終了しているため。worker の起動失敗・実行失敗（`ok: false`）は、cap を `--resume` で再開して prompt で伝える。
- `worker_report` は owner 不明・`owner.json` 破損の時だけ `error` を返す。
- `allowedTools` は別の `--allowedTools` を足さず、`session.allowedTools` の末尾へ `mcp__bantou-messenger__send_message` を足して 1 つにまとめた。
- `--append-system-prompt` は new の時だけ渡す（`--system-prompt-snapshot` が resume で使われるため）。session 切替で new に戻った時は再度渡す。`--mcp-config` / `--strict-mcp-config` は resume でも毎回渡す（broker の port が起動ごとに変わるため）。
- MCP env の既定: `AGENT_MESSENGER_CLIENT_SPEC=0.9.0`、`BROKER_CMD=false`、`CLAUDE_CODE_MESSAGING_SOCKET` / `TOKEN` は空、`npm_config_cache=<workspace>/.npm-cache`、`AGENT_MESSENGER_PKGS_DIR=<workspace>/.messenger-pkgs`（gate で必要と判明）。token が空なら `AGENT_MESSENGER_TOKEN` を入れない。`messenger.env` で全て上書き可能。
- 注入は manager が broker の接続情報を返す getter を持つ場合のみ。broker は孤児回収の後に起動するため、起動後に接続情報を差す。getter が無い時（unit test など）は従来の引数のまま。
- 子の env 整理（`AGENT_MESSENGER_*` / `CLAUDE_CODE_MESSAGING_*` の除去）は注入の有無に関わらず常に行う。`session.env` で明示した値は残す。
- sidecar（owner.json / reply_to.json）は dir の準備（clone）後に書く。先に書くと clone 先 dir が空でなくなり失敗するため。clone 時の exclude にも追加。
- reply_to の宛先は peer id（`m.from_id`）。`kick_cap` を送った peer が居なくなっていれば `cap_result 送信失敗` をログに残すだけ。
- protocol の `spawn_worker` / `worker_report` の `text` / `prompt` は非空、`kind` は `done` | `ask`。
- sandbox の扱い: 上記「sandbox の扱い」。

## 未解決

- `server/package-lock.json` は未 commit のまま（`server/` には以前 lockfile が無く、root は bun.lock のため。扱いの判断が要る）。
- tarball に `.map` と `.output/public`（Nuxt client build、約 150 kB の JS）が入る。除外は未対応。
- worker が `worker_report` を送らずに終わると、cap は再開されない（server は何もしない。run が失敗した時だけ cap に伝える）。`result_text` を自動で報告に使うかは未決。
- `resume_worker` だけで起動した worker も `worker_report` を送り得て、owner 不明の `error` が返る（無害）。
- center の `cap_kick` は `cap_id` で最初の `cap_result` だけに対応する。worker_report 後の再開で届く 2 通目以降は center では未対応（server 側は送っている）。
- broker に token を設定すると、token が `--mcp-config` の引数に載る（`ps` で見える）。
- `ps` で `BROKER_CMD=false` が detached broker を止めることの確認は「`failed` で即終了」までで、sandbox 外での直接確認はしていない。
- unit / e2e の実 claude 起動は `~/.claude-agent/projects` へ session を残す（e2e の session は消していない）。
- 削除できなかった一時物（`rm -rf` が拒否された）:
  - `/tmp/claude-1002/gate`（本段階の gate 用スクリプトと workspace）
  - `/tmp/claude-1002/e2e-b.log`
  - 段階 1 分: `/tmp/claude-1002/bantou-npx-a`、`/tmp/claude-1002/npmcache-a`、`/tmp/claude-1002/e2e-a.log`
- bantou / messenger プロセスの残存は無し（e2e・gate が起動したものは全て終了。`ps` に見える他の `bantou` / `agent-messenger` は別セッションのもの）。
