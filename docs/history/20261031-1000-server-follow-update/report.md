# 報告: desktop の更新に合わせて server を揃える

- 日付: 2026-10-31 / 実行: 204 remote cap（worker: 設計 opus 1 本、実装 sonnet 1 本。Fable 不使用）
- 指示書: `task.md`（同 dir）
- 区分: 【概念】= `docs/concept.md` の原則・task の確定事項に関わる判断、【今は】= いずれ変わり得る実装判断

## 結果

確定事項 1〜5 を実装し、単体テストと 204 の隔離 E2E で確かめた。

| 確定事項 | 実装 |
|---|---|
| 1. 組の版を desktop ビルドに書き込む | `desktop/scripts/build-sidecar.ts` が `server/package.json` の版を `BANTOU_PAIR_SERVER_VERSION` として `bun build --compile --env=BANTOU_PAIR_*` で center に埋め込む。protocol 版は center が `packages/protocol` から持つ。center は `src/pair.ts` で参照（env → `server/package.json` → 不明） |
| 2. center が版を確かめ、違えば更新を指示 | protocol `bantou` を 1.3.0 に上げ、`hello` / `hello_result` / `update_server` / `update_result` を追加。center の `src/follow.ts` が hello で版を確かめ、違えば update_server を送る |
| 3. server が自分で取り、同じ config で起動し直す。二重起動しない | server の bin を supervisor（`server/bin/supervisor.mjs`）にし、子（`--serve`）を入れ替える。取得は `npx -y --package=<spec> -- bantou`。workspace の lock で二重起動を防ぐ。新しい子が 120 秒以内に ready にならなければ直前の版へ巻き戻す |
| 4. 実行中の cap / worker が全部終わるまで待つ。待機中の新指示は理由付きエラー | `daemon.ts` が待機中の `kick_cap` を `error`（`code:"updating"`、`retryable:true`、`cap_id`）で断る。center の `remote_create` も門で止め、再送を促すエラーを返す |
| 5. 版が揃うまで指示を送らない。center 状態に「更新中」「版違い」 | center の `link.gate()` が protocol 版の違う server への指示を止める。新 tool `server_peers` が状態（ok / updating / unsupported / mismatch / failed / lost / unknown）を返し、desktop の `CenterDialog.vue` に「server の版」節を出す |

テスト用に npm 未公開の版を指す仕組みとして、server config に `update.spec` を足した（既定は npm、テストでは `file:...{version}.tgz`）。

## 判断（概念 / 今は）

### 概念

- center が server の版を確かめ、違えば更新を指示する。版が揃うまで指示を送らない（確定事項 2・5）。
- server は自分で取り、同じ config で起動し直す。二重起動しない。全部終わるまで待ち、待機中は理由付きで断る（確定事項 3・4）。
- 版の門は「宣言された protocol 版が違う」と分かった時だけ止める。版が不明（名前宛てのフォールバック、`servers[].peer` 指定）は従来どおり送る。設計案は不明も止めていたが、確定事項 5 は「合わない」server が対象で、不明を不一致と断定できないため変えた。
- `hello` / `update_server` の形は、版違いの server を更新する唯一の経路なので今後も固定の約束として扱う。

### 今は

- 自己更新の手段: supervisor + 子の入れ替え、`server.lock` / `server.ready` / `update.json` のファイル、`update.spec`。
- center の follow 周期: 通常 30 秒、更新中の server がいる間 5 秒。
- tool 名 `server_peers`、状態名、エラーコード名（updating / update_failed / update_conflict / invalid_version / version_mismatch）。
- 版の埋め込みは bun の `--env`。center 単体の `build:bin` は埋め込まない（desktop の `build:sidecar` だけ）。
- center は自動で再送しない（確定事項は「再送できる形」まで）。

## 確認（証跡）

### テスト

| 対象 | コマンド | 結果 |
|---|---|---|
| protocol | `cd packages/protocol && npm test` | 22 pass / 0 fail（cap が再実行して確認） |
| center | `cd packages/center && npm test` | 195 pass / 0 fail（cap が再実行して確認）。typecheck エラーなし |
| server | `cd server && npm test` | 172 pass / 0 fail。typecheck・build 成功 |
| server | `npm run e2e`（本物の claude、supervisor 経由の起動、hello 確認） | E2E OK |
| desktop | `bun run typecheck` | exit 0 |
| desktop | playwright `e2e/center.spec.ts` | 11 pass / 0 fail（新規 4）。初回の冷起動で先頭 1 件が落ち、再実行で pass |
| bun 埋め込み | `bun build --compile --env='BANTOU_PAIR_*'`（bun 1.4.2） | center バイナリが `組の版: server=0.2.3 protocol=1.3.0` を出した。実行時 env では変わらない |

desktop の Rust は変更なし。cargo は走らせていない。

### 204 の隔離 E2E

隔離 broker（17901）、server（内蔵 broker 17903、mcp 17902）、center（17910）。`AGENT_MESSENGER_*` の env は除去・固定。古い版・新しい版は `npm pack` した server の version を `0.0.0-e2e.N` に書き換えた tarball。実行中の cap は偽 claude（gate ファイルができるまで待つ）。server・center・broker・supervisor は本物。

1. 古い版（e2e.1）を `npx -y --package=file:...e2e.1.tgz -- bantou --config` で起動。supervisor pid 16131、子 16138。
2. 長い cap を `remote_create` で起動。
3. 組 e2e.2 の center を起動: server は `update_server` 受信 → 取得確認 OK → `更新待機: caps=1`。center の `server_peers` は `updating`。`remote_create` は「server 更新待ち（e2e.1→e2e.2）…再起動後に再送」で失敗。別 process から送った `kick_cap` は `code:"updating"`、`retryable:true` で断られた。
4. cap を終わらせると、子が終了 → supervisor が次の版を起動 → `常駐開始: version=0.0.0-e2e.2` → ready。supervisor の PID は 16131 のまま、子は 16138 → 17521。`--serve` の node は 1 本、port は新しい子だけが listen。二重起動なし。`server_peers` は ok。
5. 失敗系: 取得できない版は `failed`（server は動き続ける）。起動で落ちる版は直前の版へ巻き戻し、center は `failed` で止まる。

E2E 中に見つけて直した不具合:

- 巻き戻し後に center が同じ版を指示し続ける無限ループ。`update.json` の failed の `to` を spec から版に変えて直した。
- npx 経由で SIGTERM 終了すると supervisor が exit 1 になる。stop 要求後に子が signal で終わった場合を exit 0 にした。

## 運用上の注意・未解決

1. 初回の移行: 今の server（0.2.3、protocol 1.2.0）は自己更新を持たない。新しい center は `unsupported` と表示し、指示を止める。各ホストで一度だけ新しい版の server を手で起動し直す必要がある。
2. リリース順序: 新しい server を npm に publish してから、その版を組にした desktop を出す。逆だと `failed` になる。`desktop/CLAUDE.md` の release 手順への追記が要る（範囲外のため未変更）。
3. 組の版が違う desktop が 2 台同じ server につながると、server の版が行き来する。下げる更新を禁止するかはユーザー判断。
4. desktop の更新で center が再起動すると peer id が変わり、実行中だった remote の結果は届かない（既存の制約）。
5. 待機中も report と `worker_start` は受け付けるため、待機に上限はない。
6. supervisor は最初に起動した版のコードのまま残る。supervisor 側の取り決めを変えた時は手で起動し直す。
7. 開発中の center（tsx）は作業ツリーの `server/package.json` を組の版にするため、npm 未公開の版を要求して `failed` を表示する（表示のみ）。
8. 未実測: server の内蔵 broker に center をつなぐ構成で、子の入れ替え中に broker が止まった時の center の再接続。
9. 既存の問題（未変更）: `packages/center/scripts/e2e.ts` は古い `server/src/cli.ts` を起動する記述で、今の server では動かない。

## 後始末

停止済み: 隔離 broker、server（supervisor と子）各回、center 各回、playwright の dev server、server e2e の server。`pgrep` と `ss` で残存なし、port 17901–17903 / 17910 / 1420 は解放済み。

作業前から動いていて触っていないもの:

- `npx bantou@0.2.3 --config /home/vagrant/work/bantou-server-ws/config.json`（PID 1612、09:17 起動、port 7901 / 7902）。
- `/home/vagrant/work/webtool/develop` の headless chrome（PID 7043 ほか）。

削除できず残っているもの（`rm` が permission で拒否された。worker・cap とも単独コマンドで拒否を確認）:

- `/home/vagrant/work/bantou/scratch-e2e/`（E2E の tarball、config、ログ、作業用スクリプト）。丸ごと削除してよい。
- `/home/vagrant/work/bantou/develop/desktop/pw-local.config.ts`（untracked、playwright 用の一時 config。commit には含めていない）。
- `/home/vagrant/.npm/_npx/` の 7 件。6 件は E2E tarball の install（`09fef9d2c7566464`、`0ee2f53a54e12e63`、`518b7428b0d2ea62`、`712c8a623716f1ac`、`b281d8b68103f4a3`、`f28b83877e6e1106`）、1 件は誤って実行した `npx tsc` の install（`1d6e82a4126006c4`）。
- `/home/vagrant/.npm/_logs/` の npm ログ。
- git 管理外の build 成果物: `server/.output`、`server/protocol`、`packages/protocol/dist`、`packages/center/dist`（いずれも .gitignore 対象）。
