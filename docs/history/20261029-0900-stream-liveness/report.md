# 報告: remote-cap と worker の出力を stream-json で受け、生存と進捗を desktop で見られるようにする

- 日付: 2026-10-29 / 実行: 204 remote cap（worker: 設計 opus 1 本、実装 sonnet 2 本。Fable 不使用）
- 区分: 【概念】= `docs/concept.md` の原則に関わる判断、【今は】= いずれ変わり得る実装判断

## 結果

- server・protocol・center・desktop・docs・テストを実装。204 実測で「cap が tool で worker 起動 → center に activity が届く → worker を kill で lost」まで観測。
- commit・push 以外の範囲外作業（version bump、release、publish、agent-messenger 変更）はしていない。

## 変更

### server

- `/mcp` に `worker_start` / `worker_status` / `worker_stop`（cap header の時のみ）。worker は既存 `AgentManager` を kind=worker で使い、path 分離・state・孤児回収・process group kill を流用。起動は `claude -p --output-format stream-json --verbose`。
- cap と worker への案内文 `prompts.ts`（`CAP_GUIDE` / `WORKER_GUIDE`）。cap には worker を `worker_start` で起動するよう案内。
- `activity.ts`: stream-json を行ごとに要約（状態、最終出力時刻、直近活動、作業内容）。状態は running / stalled / idle / done / failed / lost。stalled は無音 5 分、lost は server 以外による signal 終了と起動時の孤児。
- activity を protocol `bantou` の通知で、cap を依頼した center に 5 秒間隔と状態遷移時に送る。

### protocol

- `activity` 通知を追加、version 1.1.0 → 1.2.0。`ServerReply` には入れず `ServerNotice` として別扱い。

### center

- `activity.ts`: remote ごとにメモリ保持。30 秒途絶えたら `stale`。
- `remote_list` に activity を同梱（新 tool は作らない）。

### desktop

- `RemoteActivity.vue` を新設し `CenterDialog.vue` に配置。`remote_list` を 3 秒ごとに取得し、cap と worker ごとの状態バッジ（動作中/停滞/待機/完了/失敗/消失）・作業内容・最終出力からの経過時間を表示。`stale` は「更新途絶」。
- Rust 変更なし（cargo 未実行）。`center_call`（`desktop/src-tauri/src/center_mcp.rs`）は tool 名を問わず MCP 結果を `serde_json::Value` のまま返すため、`activity` は型で落ちない（コードで確認）。

### docs

- `docs/concept.md`（「今は」節のみ）、`docs/architecture.md`（「server は worker を起動しない」を、cap の依頼で server が起動する形に改訂）、`docs/protocol.md`、`server/README.md`、`packages/center/README.md`、`desktop/README.md`、`packages/protocol/messenger/PROTOCOL.md`。

## 判断

| 判断 | 区分 | 理由 |
|---|---|---|
| worker を起動すると決めるのは cap、実プロセスは server | 概念 | ユーザー確定（A 方式）。原則 2（center/server が cap に道具を持たせる）。concept.md の原則・登場者は変更なし |
| activity は server・center ともメモリのみ | 概念（原則 6）に沿う今は | 5 秒ごとの書き込みを避ける |
| 依頼経路は server `/mcp` の tool | 今は | 既存の worker 報告の受け口を流用 |
| 生存の目安は stream-json の出力 | 今は | claude -p の現行出力。Bash 実行中も 30 秒ごとに出力が出る（実測） |
| stalled 5 分・通知 5 秒・center stale 30 秒・desktop 3 秒 | 今は | heartbeat 30 秒の実測に余裕を持たせた。調整前提 |
| lost = server 以外による signal 終了 + 起動時の孤児 | 今は | server が親なので終了 signal で判定できる |
| center は lost を作らず stale を立てる | 今は | server 側の事実ではないため |
| 通知は protocol `bantou` 1.2.0 の `activity` | 今は | 既存の通信基盤 |
| `remote_list` 拡張（新 tool にしない） | 今は | desktop は 1 回の呼び出しで足りる |

## 証跡

- packages/protocol `npm test`: 18 → 20 pass / 0 fail。
- server `npm test`: 104 → 141 pass / 0 fail。
- packages/center `npm test`: 149 → 157 pass / 0 fail。
- typecheck（server・center・protocol）エラーなし、build（protocol・server・center）成功。
- server e2e（`scripts/e2e-launch.ts`、worker 節を `worker_start` 形に変更）: `E2E OK`。
- desktop `bun run typecheck`: exit 0。e2e（`pw-local.config.ts`、chromium-1243、retries 0、sandbox off）: 32 件中 29 pass / 3 failed。新規 3 件は pass、failed は既知の `settings.spec.ts` 3 件のみ。
- 204 実測（claude 2.1.312、model sonnet、隔離 broker 17901・mcp 17902・center 17910）:
  - cap が `worker_start` で worker 起動、cap は約 7 秒で idle。
  - `remote_list` に worker が `running`、`last_activity: "Bash 実行中 60s"`、`silent_ms` は 30 秒周期内で回る。`stale: false`。
  - worker に `kill -KILL`（PID 指定）→ 0.02 秒後に server が検知 → 次の `remote_list` で `state: "lost"`、`error: "signal SIGKILL で終了（server からの停止ではない）"`。cap は idle のまま。

## 未検証

- server 停止後の center `stale`（30 秒）、server 再起動後の孤児回収による lost（単体テストで代替）。
- center の `activity 受信` ログ行（実測後に追加、204 では未確認）。
- desktop と実 center の結合、mac200 の system Chrome での e2e、実機 Tauri での見た目。

## 残件（要判断）

1. 【今は】claude の Bash tool が起動した子プロセスは別 process group にいる。worker を kill / `worker_stop` しても子（例 `tail`）が ppid 1 で残る（実測）。既存の `stop_cap` と同じ制約。回収には ppid 追跡や cgroup 等の別機構が要る。
2. 【今は】既存 cap session は system prompt snapshot のため新しい案内文を受けない。新しい `remote_id` から有効。
3. 【今は】`STALLED_MS` 5 分は、長い 1 ブロック生成・subagent 実行中の無音を計測して調整が要る可能性。
4. 【今は】cap が `worker_start` を使わず Bash で `claude` を直接起動した場合は可視化の対象外（案内文でのみ抑止）。
5. desktop `center.spec.ts` の既存 1 件目が単体実行で 1 回 failed（全体実行では pass）。原因未切り分け。
6. 既存挙動（報告のみ、未変更）: `kick_cap` で `repo` 付き初回に `prepareDir` が失敗しそう（推測、未検証）。

## 経過の注意

- desktop worker が確認のため `git stash` → `git stash pop` を一度実行（repo 全体に効く）。直後に server 側の変更が全部残っていることと、テスト件数が同じことを再確認した。

## 後始末

- 実測の server・center・worker の子プロセスは停止済み。`pgrep` 空、3 port 解放を確認。desktop の nuxt / chrome も停止、port 1420 解放。
- 削除が permission で拒否され残存（回避していない）:
  - `/home/vagrant/work/bantou/probe-liveness/`（実測のログと使い捨て設定）
  - `/tmp/claude-1002/sj/`、`/tmp/claude-1002/sjtool/`（設計時の計測物）
  - `/tmp/claude-1002/dev.log`（desktop e2e のログ）
- `desktop/pw-local.config.ts` は前回からの未追跡のまま（commit に含めない）。
