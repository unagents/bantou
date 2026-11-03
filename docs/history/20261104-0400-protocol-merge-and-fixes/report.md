# protocol-task の merge と修正（B 節: center の通知先と remote 記録の扱い）

A 節（merge の解消方針）は cap が最終 report にまとめる。この節は B1 / B2 の取り決めの変更とテスト件数。

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
  - 同じ server（peer id が同じ、または `serverName` + `serverHost` が同じ。`serverHost` を持つ前の旧形式は名前だけで同じとみなす）に複数ある時: 形式を問わず最新の 1 件（`createdAt` / `finishedAt` / `result_at` / `error_at` のうち最も新しい時刻）を残す。他は `stop_cap` を送って（届かなくても）記録を消す。作業ごとの cap の後始末で、1 回限り。
  - cap_id は server ごとに記録が持つ（`remote_id`）。`send` / `status` / `worker_reply` / `delete` はその server の記録の cap_id を使い、記録の無い server だけ center の cap_id（`center-id`）で作る。`remote_id` 省略の `remote_delete` / `worker_reply` は、記録が 1 件ならそれ、複数なら `server` で絞らせる（以前は center の cap_id に決め打ち）。

### 判断が要るかもしれない点

- 「最新」は、旧形式の running の記録より finished の新しい記録を残すことがある（その場合、running 側は `stop_cap` で止まる）。指示どおり最新を残している。
- 同じ server に新形式（center の cap_id）の記録と旧形式があっても最新の 1 件を残す（旧形式の方が新しければ center の cap_id の記録は `stop_cap` で消える）。
- `serverHost` の無い旧記録は、起動時の `status` が成功し、同名の peer がその 1 件だけの時に、今の peer id と host を記録に入れる（同名が複数なら入れない）。

### テスト件数

- protocol: 29 pass（status の cap_id・版 1.6.0 を追加）。
- server: 232 pass（reports に名前で覚える・同名複数・命令で更新・dir を作らない・旧形式・引けない時、daemon に `commandCapId` を追加）。typecheck OK。
- center: 347 pass（旧記録の引き継ぎ、複数あれば最新を残す、形式を問わず最新を残す、host の無い旧記録の扱い、`remote_delete` 以外で消えない、起動時の status 送信と再試行、server ごとの cap_id、link の `statusOn` の cap_id）。typecheck OK。
- 実機確認は未実施（center 再起動後に activity が届くこと）。

### 変更ファイル

- protocol: `src/server.ts`、`messenger/protocol.json`、`messenger/PROTOCOL.md`、`test/server.test.mjs`。
- server: `server/utils/bantou/daemon.ts`、`reports.ts`、`package.json`、`README.md`、`test/server/utils/bantou/{daemon,reports}.test.ts`。
- center: `src/remotes.ts`、`src/server-link.ts`、`README.md`、`test/{remotes,server-link}.test.ts`。
- docs: `docs/protocol.md`、`docs/architecture.md`、`docs/design/center-tools.md`、`docs/design/master-cap-session.md`。
