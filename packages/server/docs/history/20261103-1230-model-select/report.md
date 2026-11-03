# model 指定（bantou-server 側）

## 原因（なぜ必要か）

- server は cap / worker の `claude -p` に `--model` を渡す経路が無かった（`session.extraArgs` の全員共通指定のみ）。
- 経路ごとに model を選べるようにする（center → `kick_cap` → cap → `worker_start` → worker）。

## 変更（server/ 配下のみ。packages/ は触っていない）

- `server/utils/bantou/model.ts`（新規）: model 形式検証（`^[A-Za-z0-9._\[\]][A-Za-z0-9._\[\]-]*$`、先頭 `-` 不可 = protocol の `MODEL_PATTERN` と同じ）、`logs/model.json`（`{model?, worker_model?}`）の読み書き。
- `claude.ts`: `ClaudeRunOptions.model`。`extraArgs` の後ろに `--model <値>`（`extraArgs` の `--model` より後勝ち）。省略時は付けない。
- `agents.ts`: `InvokeInput` に `model` / `worker_model` / `defaultModel`。invoke で検証（不正は reject、claude は起動しない）。解決順は 指定 > 記録 > `defaultModel`。指定があれば `logs/model.json` に残し、無い再開（report 起因・次の kick_cap・worker の続き）は記録を使い続ける。`status` の `caps[]` / `workers[]` に `model`（無ければ null）。
- `workers.ts` / `mcp.ts`: `worker_start` に `model`。指定が無ければ worker の前回記録、それも無ければ cap の `worker_model`、それも無ければ付けない。`worker_status` の `model`。
- `activity.ts`: `agents[]` の各要素に `model`（無ければ null）。
- `daemon.ts`: `kick_cap` のログに `model=` / `worker_model=`。`model` / `worker_model` は `cmd` ごと `manager.invoke` に届く。
- `README.md`: `kick_cap` / `worker_start` / activity / `logs/model.json`。
- テスト: `test/server/utils/bantou/model.test.ts`（12 件）。`update.test.ts` と `test/fixtures/msg-client.mjs` は protocol 版を `MESSENGER_PROTOCOL.version` から取るよう変更（版 1.3.0 の直書きが 1.4.0 で落ちるため）。

## テスト

- `npm test`（server/）: 202 件 通過 / 失敗 0。typecheck 0 error。
- 2 通りで確認: (a) develop の protocol（1.3.0、model 無し）で build、(b) `origin/fix/model-select`（d5e4058、protocol bantou 1.4.0）を push しないローカル検証 branch に merge して build。どちらも 202/202。
- 既存 `launcher` の 1 件（supervisor 引き継ぎ）が全件並列実行で 1 度だけ落ちた。単体・再実行は通過。model と無関係（時間依存の不安定さ）。

## 古い相手との互換

- 古い center（model を送らない）: 従来どおり。`--model` は付かない。`model.json` も作らない。
- 古い server（本変更なし）に新 center が `model` を送る: 無視される（protocol 側の取り決め）。
- 古い protocol package で build しても動く: 型に無い項目は server 内で省略可の項目として扱う（`WithModel<T>`、`cmd` の型アサーション）。
- 新 protocol の guard は不正な model を持つ `kick_cap` を弾く。server 側も同じパターンで検証する（二重）。
- `status_result` / `activity` に足した `model` は省略可。知らない center は無視する。

## protocol の合わせ方と merge 順序

- 合わせた protocol: `origin/fix/model-select` d5e4058（protocol bantou 1.4.0）。server branch には protocol の変更を載せていない。
- merge 順序: 先に `fix/model-select`（protocol + center）、次に `fix/model-select-server`。server は `@agent-hand/bantou-protocol` を `file:../packages/protocol` で参照するため、先に protocol が入る必要がある。
- 公開: server を npm publish する前に、同梱する `protocol/`（`scripts/copy-protocol.mjs`）が 1.4.0 であることを確認する。version bump・release は本作業では行っていない。

## 既知の限界

- server 再起動後に孤児回収が作る `lost` の activity は model が null（記録は `logs/model.json` に残っているが、seedLost では読んでいない）。
- `docs/protocol.md` は bantou 側 branch の担当のため触っていない（server の `model.json` の記述は `server/README.md` のみ）。

## 後始末と残存物

- 作業 dir: `/home/vagrant/work/bantou-server-ws/workers/w-model-server/`（clone `bantou/`）。検証 branch `verify/model-select-merge` はローカルのみ（push しない）。
- `package-lock.json`（root と server/）は npm install の生成物で commit していない。
- 起動したサーバー・プロセスは無し（テストのみ）。
