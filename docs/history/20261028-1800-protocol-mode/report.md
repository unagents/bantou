# 報告書: center ↔ server を agent-messenger の protocol 方式へ移行（204）

- 日付: 2026-10-28 / 作成: 204 remote cap `wcap-bantou`
- 指示書: 同 dir の `task.md`
- worker: opus（調査）、sonnet（実装）

## commit（develop、dc6d73d..fff0554 を push 済み）

| commit | 内容 |
|---|---|
| `7609d70` | protocol 定義（`packages/protocol/messenger/protocol.json`、`PROTOCOL.md`） |
| `23aa383` | server: messenger 0.10.0、`setProtocol` 登録、meta 付き返信 |
| `5e68680` | center: messenger 0.10.0、`listPeers` による server 発見、meta 付き送信 |
| `f35f798` | desktop: 設定に center の `servers`（name と broker URL）を追加 |
| `971e33f` | docs |
| `fff0554` | version: desktop 0.1.9 |
| 本報告書 | 別 commit（task.md 含む） |

- main、npm publish、release には触れていない。plugin/ も変更していない。

## 要件ごとの結果

### 1. protocol 定義
- `packages/protocol/messenger/protocol.json` を作った。
  - `name: "bantou"`、`version: "1.0.0"`、`description` あり。
  - `messages` は `kick_cap` / `status` / `cap_result` / `status_result` / `error` の JSON Schema。
- 同じ dir に `PROTOCOL.md`（LLM 向けの運用説明）を置いた。
- `src/server.ts` に `MESSENGER_PROTOCOL = {protocol: "bantou", version: "1.0.0"}` を置いた。test で protocol.json と一致することを確認する。
- server への同梱:
  - build / dev / e2e / prepack の先頭で `scripts/copy-protocol.mjs` が `server/protocol/` にコピーする。
  - `server/protocol/` は package.json の `files` に入れ、gitignore 対象にした。
  - `bin/bantou.mjs` が install 先からの絶対パスを `NUXT_BANTOU_PROTOCOL_DIR` で渡す。
  - `npm pack --dry-run` の結果は `bantou-0.2.0.tgz`（509 files、1.4 MB）。`protocol/protocol.json`（4.3 kB）と `protocol/PROTOCOL.md`（1.8 kB）が含まれる。

### 2. server（npm `bantou` 0.2.0）
- `@unagents/messenger-broker` / `-client` を 0.10.0 に上げた。
- 起動時に `setProtocol(<protocol dir>)` で待受登録し、ログに name@version と hash を出す。
- 受信は `meta.protocol === "bantou"` のものを処理する。
  - meta 無しの旧形式も当面受ける。
  - 他の protocol は無視してログに出す。
- 返信は送信元へ `send(from_id, text, "pull", meta)` で返す。report 起因の `cap_result` にも meta を付ける。
- 終了時に `unsetProtocol`。

### 3. center
- `@unagents/messenger-client` を 0.10.0 に上げた。
- server の発見:
  - `servers[].peer` の指定があれば従来の名前指定。
  - 無ければ `listPeers("all", {protocol: "bantou"})` で探す。
  - peer id は再登録で変わるので、リクエストごとに解決する。
- 送信に `meta: {protocol: "bantou", version}` を付ける。
- 受信 text の先頭に付く `[agent-messenger warning]` 行を除いてから parse する。

### 4. desktop
- `CenterSettings.servers`（`{name, broker}` の配列）を追加し、center.json に書き出す。
- 入力の検証は center 側と揃えた。
  - name は英数と `_-`、重複不可。
  - broker は `http://` のみで、末尾の `/` を除く。
- `servers` の変更は center 再起動の対象にした。
- 設定ダイアログに servers 欄（name と broker URL、追加・削除、`data-testid="center-server"`）を追加した。

### 5. テスト

| 対象 | コマンド | 結果 |
|---|---|---|
| packages/protocol | `npm run build` / `npm test` | build OK、17 pass / 0 fail |
| server | `npm run typecheck` / `npm run build` / `npm test` | OK / OK / 98 pass / 0 fail |
| packages/center | `npm run typecheck` / `npm run build` / `npm test` | OK / OK / 94 pass / 0 fail |
| desktop | `bun run typecheck` | exit 0（TS エラー 0。`vue-router/volar/sfc-route-blocks` の警告は変更前から出る） |
| desktop/src-tauri | `cargo check` / `cargo test --lib center` | OK（既存の警告 4 件）/ 14 pass / 0 fail |

- server の unit では、実 broker で `setProtocol` → `listPeers(protocol)` → meta 付き送信 → `unsetProtocol` を確認した（`protocol-registration.test.ts`）。
- center の unit で確認した内容:
  - protocol による発見と、複数 peer の優先規則。
  - 0 件・BROKER_UNSUPPORTED のときの fallback。
  - `servers[].peer` 指定、リクエストごとの再解決。
  - 受信照合と警告行の除去。

#### server e2e
- 構成: 内蔵 broker（port 0 / 127.0.0.1 / discovery off）、実 claude、`CLAUDE_CONFIG_DIR=/home/vagrant/.claude-agent`、`--model sonnet`。
- 1 回目は sandbox 内（allowed_domains 付き）で実行した。
  - protocol 登録、発見、meta 付き kick_cap、1 回目の meta 付き cap_result までは通った。
  - resume で `session が無いので新規に切り替え` になり NG。sandbox 内では session が保存されない、既知の事象。
- 2 回目は sandbox 外で実行し（権限ゲートは通過）、`E2E OK`（exit 0）。ログ抜粋:

```
bantou: peer 登録: name=bantou-server id=41du98us broker=http://127.0.0.1:43123
bantou: protocol 登録: bantou@1.0.0 hash=e3bc1e9a3615815c354cd210e7279837f746f92723624d5c2aeb51700820e080 dir=/home/vagrant/work/bantou/develop/server/protocol
[e2e] listPeers(protocol=bantou) = [{"id":"6cubkpck","name":"bantou-server","protocols":[{"name":"bantou","version":"1.0.0","hash":"e3bc1e9a..."}]}]
指示受信: type=kick_cap from=bantou-e2e-sender(bjyls87z) cap_id=e2e-cap-1851359 ...
返信: to=bjyls87z type=cap_result meta=bantou@1.0.0
[e2e] cap_result (1 回目): type=cap_result meta={"protocol":"bantou","version":"1.0.0"}
無視(他 protocol): ... protocol=other-proto
無視: ... text=hello
```

- `listPeers` の行は 1 回目（sandbox 内）の client 側ログ。
- 次の返信にもすべて同じ meta が付いた。
  - resume 後の cap_result、worker 起動の cap_result、report 起因の cap_result、status_result。
- meta 無しの旧形式 `status` も受理して返信した。
- 終了時は `protocol 解除` → `mcp 停止` → `broker 停止` → `終了`（exit 0、port の解放も確認）。

### 6. version
- desktop を 0.1.9 にした（`desktop/package.json`、`Cargo.toml`、`Cargo.lock`、`bun.lock`。0.1.8 の bump と同じ 4 ファイル）。
- server（npm `bantou`）は 0.2.0。

### 7. docs
- `docs/protocol.md`、`docs/architecture.md`（「未決」から移行時期の項を削除）を更新した。
- 各 README（server、packages/center、packages/protocol、desktop）を更新した。

## 判断した点

- protocol.json の `version` は `1.0.0` にした。本文中の `bantou: 1`（PROTOCOL_VERSION）とは別物として扱う。
- `description` は messenger の必須項目なので入れた（task.md には書かれていない）。
- `messages` は task.md の 5 種だけにした。
  - `resume_worker` / `worker_result` は server が未対応なので入れていない。TS 型は center のために残した。
  - `error` の `command` enum には `resume_worker` を含めた。
- protocol.json は build 時に server package へコピーして同梱する。
  - Nitro serverAssets と publicAssets は使わなかった。
  - setProtocol はディスク上の dir を要求し、protocol package は bundle されてファイルとして残らないため。
- `setProtocol` の失敗は致命にしない。ログを出し、従来の名前待受（`bantou-server`）で続ける。
- server の返信は、送信元の meta の有無にかかわらず常に meta を付ける。
- messenger は、相手の meta の version と自分の宣言が違うと、送信 text の先頭に警告行を付ける。その対策を center に入れた。
  - meta には、発見した peer の `protocols[].version` を使う。
  - 受信 text 先頭の `[agent-messenger warning]` 行は除いてから parse する。
- center の server 選択規則:
  - `servers[].peer` の指定があればそれを使う。
  - 無ければ `listPeers` の結果で、name が `bantou-server` の peer を優先し、無ければ先頭を使う。
  - 0 件・BROKER_UNSUPPORTED は `bantou-server` 宛てに fallback する。
- center の受信照合は、次のいずれかに当たれば server からの返信とみなす。
  - 解決済みの id。
  - `meta.protocol=bantou`。
  - name が `bantou-server`。
  - `servers[].peer`（name か id）。
- `LinkClient.listPeers` は optional にした。無い時と失敗時は名前宛てに fallback する。
- center の `server_list` 出力に `serverPeer`（直近に解決した送信先）を追加した。既存項目は変えていない。
- desktop の config キーは、center に合わせて `broker` にした（task.md の「broker URL」）。
- e2e は `NUXT_IGNORE_LOCK=1` を付けて実行した。中断した 1 回目の build が `.nuxt` に stale な build lock を残したため。
- `server/package-lock.json` は既存方針どおり commit していない。

## 未解決

- desktop の Playwright e2e（`desktop/e2e/*`）は実行しておらず、servers 欄用の spec も追加していない。
- 1 つの broker に bantou server が複数いる構成は、上の選択規則で 1 つを選ぶだけ。
- 同じ version のまま protocol.json の中身を変えると、同じ broker に旧定義の server が残っている間は PROTOCOL_CONFLICT になる。中身を変えたら version を上げる運用にする。
- messenger の npm package には README と docs が含まれていない。仕様の正本は agent-messenger repo の `docs/design/protocol.md`。
- 一時物の残り: `rm` が permission で拒否され、次が残っている。
  - `/tmp/claude-1002/` 直下:
    - `bantou-e2e-wzwDZ9`、`npm-cache`、`bun-cache`、`msgr.eXRx`
    - `e2e.log`、`tc.log`、`tc0.log`
    - `protocol-mode-brief.md`
  - `/tmp/e2e2.log`
  - 前回までの分（`20261028-1600-server-nuxt-flow/report.md` の一覧）も残っている。
- 今回と無関係の常駐 `bantou`（pid 1564597 / 1564699）には触れていない。
