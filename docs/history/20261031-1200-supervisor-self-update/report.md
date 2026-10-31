# 報告: server の入れ替え管理（supervisor）自身も更新されるようにする

- 日付: 2026-10-31 / 実行: 204 remote cap（worker: 設計 opus 1 本、実装・テスト・E2E sonnet 1 本。Fable 不使用）
- 指示書: `task.md`（同 dir）
- 区分: 【概念】= `docs/concept.md` の原則・task の確定事項に関わる判断、【今は】= いずれ変わり得る実装判断

## 結果

center からの更新で、supervisor も新しい版のものに替わるようにした。単体テストと 204 の隔離 E2E で確かめた。

方式は「変わらない最小の launcher を残し、supervisor 同士で引き継ぐ」。

```
起動元 → npx → sh → node bantou.mjs                 [launcher、PID 不変、以後変えない]
                     └ node bantou.mjs --supervise    [supervisor S1]
                          └ (detached) --serve        [子 C1]
更新後: launcher は残り、S1 は終了。新版の --supervise [S2] とその子 [C2] が動く
```

入れ替えの流れ（旧 S2 → 新 S3）:

1. 子は実行中の cap / worker が全部終わるのを待ってから、restart を書いて終わる（既存のまま）。
2. S2 が新版に `--handoff-protocol` で問い合わせる。応答が無い版（0.3.0 など）なら、従来どおり子だけを入れ替える。
3. S2 が `server.lock` に `next:{token}` を書き、新版の `--supervise` を同じ config で detached 起動する。
4. S3 は試行モードで子を起動して ready を待ち、`next.ready=true` を書く。
5. S2 は lock の持ち主を S3 に書き換え（atomic rename）、`update.json` の restart を消して終わる。
6. S3 が ready にならなければ、S2 が S3 と試行の子を止め、lock を自分に戻し、`update.json` に failed を書き、直前の版の子を同じ config で起動し直す。

lock の持ち主は昇格まで生きている S2 のままなので、第三者の起動は入れ替え中も「既に起動中」で断られる。launcher は lock の系列が生きている間残り、SIGTERM / SIGINT を今の supervisor へ中継する。

### 変更ファイル

- `server/bin/launcher.mjs`, `launcher.d.mts`（新規）
- `server/bin/supervisor.mjs`, `supervisor.d.mts`, `bantou.mjs`（`--supervise` / `--handoff-protocol` を追加。フラグなしの既定は launcher。`--version` は 1 行のまま）
- `server/README.md`（「PID は変わらない」の記述を直し、launcher と引き継ぎを記述）
- `docs/architecture.md` 34 行（同じ記述の 1 文を直した。task の対象一覧外だが、今回の変更で生じた不整合の調整）
- テスト: `server/test/server/utils/bantou/{supervisor,handoff,launcher}.test.ts`、fixture `fake-serve.mjs` / `fake-next.mjs` / `fake-supervise.mjs` / `supervisor-0.3.0.mjs`（c48cf72 の supervisor そのまま。互換テスト用）

`update.ts` / `daemon.ts` は互換のため変えていない。

## 判断（概念 / 今は）

### 概念

- 更新で supervisor も新しい版に替わる。
- 既存の取り決めは保つ: 全部終わるまで待つ（A）、二重起動しない（workspace lock）、起動しなければ直前の版へ戻す、同じ config で起動し直す。
- 外から見た形は保つ: `npx bantou@<版> --config ...` を 1 回起動すれば、以後は自分で更新し続ける。npx が起動したプロセス（launcher）は終わらない。
- 0.3.0 以前の supervisor からは、もう一度だけ手で起動し直す。以後は手作業が要らない。

### 今は

- 方式: 凍結した launcher と supervisor 同士の引き継ぎ。比較した案と退けた理由:
  - 「新 supervisor に引き継いで自分は終わる（launcher なし）」: npx が終わり、起動元（シェル / tmux / サービス管理）からは停止に見えるため退けた。
  - 「launcher が全 supervisor の親になる」: 起動依頼や巻き戻しの経路を launcher に持たせることになり、凍結する範囲が広がるため退けた。
  - 「launcher に ready 判定・巻き戻しも持たせる」: 今の supervisor の名前を変えるのと同じで、変わり得る判断が凍結側に残るため退けた。
- 巻き戻しは旧 supervisor が持つ。試行中の新 supervisor は lock の `next` に入れ、成功後に昇格させる。
- launcher について凍結する取り決め（以後変えない）: config の `workspace`、lock の `pid` / `launcher`、`server.exit` の `{launcher, code}`、中継する信号 SIGTERM / SIGINT、env `BANTOU_LAUNCHER_PID`。launcher は node 組み込みのみを使い、起動後は package dir を読まない。
- supervisor 同士の取り決め: `--handoff-protocol`、`--supervise`、lock の `next` の形、`BANTOU_HANDOFF_TOKEN`。
- supervisor と子の取り決め（ready、`update.json`、終了コード、`--serve`）は変えていない。新版の子は 0.3.0 の supervisor の下でも動く。
- lock の形: `{pid, version, started_at, launcher?, child?, next?:{token,pid,version,child,ready}}`。`pid` / `version` は supervisor 自身のもの。外から supervisor の PID と版を読む手段はこの lock。hello への追加は protocol の変更になるため、今回は入れていない。
- 時間: 見張りの間隔 500ms、試行の ready は 120 秒、旧 supervisor が待つ上限は 120 秒 + 取得の猶予 60 秒、probe は 120 秒。

## 確認（証跡）

### テスト

| 対象 | コマンド | 結果 |
|---|---|---|
| server | `cd server && npm test` | 189 pass / 0 fail（変更前は 172。17 件追加。cap が再実行して確認） |
| server | `npm run typecheck` | exit 0 |
| server | `npm run build` | 成功（cap が再実行して確認） |

追加したテスト:

- 引き継ぎ: 成功、lock 前に crash、lock 後に crash、lock 後に SIGKILL、hang、ready 前に子が crash、試行中の停止、probe 失敗時に子だけ入れ替え、0.3.0 supervisor の下で新版の子が動く互換。
- lock: 引き継ぎ中に第三者を拒否、token 不一致では join しない、持ち主が替わった後の release は何もしない。
- launcher: env の付与、信号の中継、`server.exit` の code で終わる、引き継ぎ後も残る、二重起動の時は exit 1。
- どの場合も serve 子が同時に 2 本にならないことを確かめた。

Rust の変更は無く、cargo は走らせていない。`npm run e2e`（本物の claude）は未実行。

### 204 の隔離 E2E

- 条件: 隔離 port 17921（内蔵 broker）/ 17922（mcp）、別 workspace、別 config。claude は偽物、server / supervisor / launcher は本物。
- 版: `npm pack` した tarball の version を `0.0.0-e2e.N` に書き換え、`update.spec=file:...{version}.tgz` で指した。
  - e2e.1 は今のコード。e2e.2 / e2e.3 は supervisor に目印のログ行 `SUPERVISOR-MARKER` を足した版。
  - e2e.4 は目印 + 子の起動が 8 秒遅い版。e2e.5 は `--supervise` が即座に落ちる版。e2e.6 は `--serve` が落ちる版。
  - e2e.0 は bin だけ c48cf72（0.3.0 相当）。
- npx の取得先は `npm_config_cache` で作業ツリー内に向けた。`~/.npm/_npx` は前後とも 30 件で、増えていない。

1. 更新で supervisor が替わる:
   - 起動時の lock は `{pid:48, version:0.0.0-e2e.1, launcher:41, child:55}`。
   - 長い cap の実行中に e2e.2 を指示すると `waiting`（caps=1）になり、待機中の lock は pid 48 のまま変わらなかった。
   - cap を終わらせた後の lock は `{pid:216, version:0.0.0-e2e.2, launcher:41, child:223}`。
   - 旧 supervisor 48 は消え、launcher 41 は生きたまま変わらなかった。
   - ログに `SUPERVISOR-MARKER e2e.2 pid=216` が出た。`--supervise` と `--serve` は各 1 本。hello は e2e.2。`update.json` は残っていない。
2. 続けて e2e.3 へ更新: lock.pid は 216 から 310 になり、launcher 41 は変わらなかった。引き継いだ後の supervisor からも、さらに引き継げる。
3. 巻き戻し:
   - e2e.5（`--supervise` が即座に落ちる）: `update.json` は failed（`次期 supervisor が ready 前に終了`）。lock.pid は旧 34 のままで、`next` は消えた。直前の版の子（新しい pid 124）が起動し直し、hello は e2e.1。
   - e2e.6（子が落ちる）: 同じ結果になった。孤児は残らなかった。
   - 失敗の後に e2e.2 へ更新すると、通常どおり引き継げた。
4. 二重起動なし:
   - 通常時に 2 本目を起動すると exit 1（`既に起動中 pid=48`）。
   - 引き継ぎ試行中（e2e.4、lock に `next` がある間）に 3 本目を起動しても exit 1。試行はそのまま完了した。
5. 0.3.0 相当からの移行:
   - e2e.0 から e2e.1 への更新は、子だけが入れ替わった（supervisor pid 27 は不変。想定どおり）。新版の子は 0.3.0 の supervisor の下でも動いた。
   - 手で起動し直すと、新方式（launcher あり）に移った。
   - 新方式から e2e.0 へ下げる更新は、`引き継ぎ非対応の版、子だけ入れ替える` に落ちた。
6. 停止:
   - launcher へ SIGTERM を送ると、系列全体が止まった。`server.exit={"launcher":41,"code":0}`、lock は消え、npx は exit 0。
   - serve 子を SIGKILL した時は、launcher が exit 1 で終わった。

## 移行（運用上の手作業）

- 0.3.0 の server は、この版への更新を受けても子だけが入れ替わり、supervisor は 0.3.0 のまま残る。各ホストで **もう一度だけ** 手で `npx bantou@<新しい版> --config ...` に起動し直す必要がある。以後は手作業が要らない。

## 未解決・未実測

1. npx のプロセス（`npm exec`）へ SIGTERM を送ると、`npm exec` と `sh` だけが落ち、node の launcher 系列は孤児として残る。変更前の 0.3.0 方式でも同じだった（既存の挙動）。launcher の実 PID は lock の `launcher` で分かる。launcher が親の死を見て自分で終わる対策を入れるかは、ユーザー判断。
2. 旧 supervisor が昇格の前に死に、ready 済みの新 supervisor が自分で昇格する分岐は、実装のみ。単体テストも E2E も無い。
3. `npm run e2e`（本物の claude）は未実行。
4. 引き継ぎ中に broker が止まる間の center の再接続は未実測（前回から継続）。
5. E2E 中、`update_result` が引き継ぎより後に届くことがあった。pull 配送の遅延（既存の挙動）と見ているが、今回の変更が原因でないかは確かめていない。
6. launcher を `kill -9` すると、系列は見張り役なしで動き続ける（今の supervisor を `kill -9` した時と同じ）。

## 後始末

- 起動したプロセスは、各 E2E シナリオの終わりに記録した PID だけを止めた。残存プロセスが無いこと、port 17921 / 17922 が解放されたことを、E2E スクリプト内の ps と `ss -tlnp` で確かめた。最終の `pgrep -f 'bantou|e2e'` も該当なし。
- 作業前から動いていて触っていないもの: `npx bantou@0.2.3`（PID 1612、port 7901 / 7902）、webtool の headless chrome。

削除できず残っているもの（`rm` が permission で拒否された。worker・cap とも単独コマンドで拒否を確認）:

- `/home/vagrant/work/bantou/develop/.e2e-tmp/`（約 150MB）: E2E の tarball、npm-cache、ログ、証跡（`evidence-*.log`）、作業用スクリプト。丸ごと削除してよい。git 管理外で、commit には含めていない。
- `/tmp/claude-1002/bantou-launcher-test-*`（7 件）: タイムアウトで止めた単体テストの tmp。
- `/tmp/claude-1002/full2.log`、`/tmp/claude-1002/tc2.log`: テストの出力。
- `~/.npm/_logs/` の npm ログ 1 件（`npm pack` の失敗時のもの）。
- git 管理外の build 成果物: `server/.output`、`server/protocol`、`server/.nuxt`（いずれも .gitignore 対象）。

前回からの残り（`desktop/pw-local.config.ts`、`~/.npm/_npx` の既存件）には触っていない。
