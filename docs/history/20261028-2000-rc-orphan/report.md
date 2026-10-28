# 報告書: center 終了時に remote-control の子を確実に止める（204）

- 日付: 2026-10-28 / 作成: 204 remote cap `wcap-bantou`
- 指示書: 同 dir の `task.md`
- worker: opus（調査・再現）、sonnet（実装）

## commit（develop、9feb7eb..e687fbc を push 済み）

| commit | 内容 |
|---|---|
| `3f7cc73` | bantou 0.1.10（desktop/package.json、src-tauri/Cargo.toml、Cargo.lock、bun.lock） |
| `e687fbc` | center: rc 孤児の回収、process group 起動、全終了経路での子の停止 |
| 本報告書 | 別 commit（task.md 含む） |

- main・release には触れていない。server/・plugin/ も変更していない。

## 原因

- 204 で、実物の center（`bun build --compile`、bun 1.4.2）と stub の remote-control を使って実測した。
- 主原因（要件 1 を再現）: center が SIGKILL やクラッシュで死ぬと、子の停止処理が走らない。
  - 子は `detached` なしで起動していた（remote-control.ts:214）。
  - その結果、子は ppid=1 の孤児になって残る。pgid は死んだ center のものではなく、desktop のものを共有している。
  - center は起動時に回収をしない（daemon.ts:75-80）。次の center が同じ project の remote-control をもう 1 本起動し、2 本に重複する。mac200 の事象と一致する。
  - 孤児の argv に `--continue` があったので、再起動経路（remote-control.ts:331）で起動した個体と分かる。
- 孫が残る経路: 停止は `child.kill()` で直接の子の pid にだけ送っていた（remote-control.ts:376, 380）。
  - stub が起動した孫は ppid=1 で残った。
  - 親の消滅を検知して終了する経路でも同じことが起きた。stub が TERM を無視すると 1 秒後に SIGKILL され、直接の子は止まるが孫は残る。
  - 実物の claude が子プロセスを持つかは未確認。
- 構造上の危険（実測では再現していない）:
  - shutdown は `http.close()` を待ってから子を止めていた（daemon.ts:47-48）。強制終了タイマー（daemon.ts:41-44）が先に切れると、子に何も送らず exit(1) する。
  - uncaughtException / unhandledRejection の handler が無く、例外で落ちると shutdown を通らない。
  - 読み手のいない stderr への書き込みで EPIPE が出ると、shutdown 前に落ちる可能性がある。Linux では起きず、mac は未確認。
- desktop 側には原因が見つからなかった。
  - 停止は SIGTERM → 15 秒待ち → SIGKILL の順（center.rs:30, 323-349）。15 秒は center の最悪の終了時間より長い。
  - アプリ終了時は `RunEvent::Exit` で stop() を呼ぶ（lib.rs:135-137）。
  - tauri-plugin-shell が Exit 時に SIGKILL するのは JS から spawn したものだけで、Rust 側の sidecar は対象外。
  - cask に `quit` の指定は無く、brew upgrade はアプリを止めない。
- 0.1.8 の center がなぜ終了したかは追えなかった。center のログは desktop のメモリ上にしか残らないため。

## 対策（e687fbc）

- **process group で起動し、group ごと止める**（remote-control.ts）
  - 子を `detached: true`（setsid）で起動する。
  - 停止は `process.kill(-pid, sig)` で group 全体に送り、孫まで止める。ESRCH / EPERM の時は `child.kill` に戻す。
  - 子の停止処理は注入できるようにした（テストの偽 pid で実在の group を撃たないため）。
  - `killAllSync(sig)` を追加した。生きている子の全 group に同期で送る。
- **起動時に孤児を回収する**（新規 reap.ts。stroke の reap と同じ考え方）
  - `ps -A -ww -o pid=,ppid=,pgid=,command=` でプロセス一覧を取る。失敗した時は回収をせず、起動は続ける。
  - 次の全てに当たるものを孤児とする。
    - ppid=1。
    - argv に `remote-control` がある。
    - `--name <project>` が token 単位で完全一致する。
    - 自分でも自分の子でもない。
  - 止め方は SIGTERM → 3 秒待ち → SIGKILL。
    - SIGKILL の直前に一覧を取り直し、argv を再照合する（pid の再利用への対策）。
    - group 宛てに送るのは pgid=pid の時だけ。0.1.9 以前の孤児は desktop の pgid を共有しているので、pid 単体にだけ送る。
  - `supervisor.start()` が launch の前に回収する。自分の子がいる再起動経路では回収しない。
- **全ての終了経路で子を止める**（daemon.ts / log.ts）
  - shutdown は、子の停止・http の close・link の close を `Promise.allSettled` で並行に行う。子の停止が http の close 待ちにならない。
  - 強制終了タイマーは、exit(1) の前に `killAllSync('SIGKILL')` を呼ぶ。
  - `process.on('exit')` でも `killAllSync('SIGKILL')` を呼ぶ（最後の砦）。
  - uncaughtException / unhandledRejection / SIGHUP も shutdown に流す。
  - stdout / stderr の error（EPIPE）は握りつぶす。
  - center のログを `logDir/center.log` にも追記する（次に同じ事象が起きた時に追えるように）。
- **desktop**
  - 挙動は変えていない。
  - `STOP_GRACE`（15 秒）を center の最悪の終了時間より長く保つ旨を、center.rs のコメントに書いた。

## テスト結果

| 対象 | 結果 |
|---|---|
| center typecheck / build | エラーなし |
| center `npm test` | 108 pass / 0 fail（新規: reap 8 件、supervisor 5 件、再現 1 件） |
| desktop `cargo check` | OK（lib の既存 warning 4 件） |
| desktop `cargo test --lib center` | 14 pass / 0 fail |
| desktop `bun run build:sidecar` | 成功（bun-linux-x64） |

- desktop の TS は変更していないので、`bun run typecheck` は実行していない。
- 再現テスト（`test/rc-orphan.test.ts`、stub の remote-control）は 3 回続けて pass した（各約 1 秒）。手順と確認内容:
  1. center A を SIGKILL する。stub が ppid=1・pgid=自身で生き残り、孫も生きていることを確認する。
  2. center B を起動する。ログに `孤児回収: SIGTERM` が出て、stub の signal ログに旧 pid の SIGTERM が残ることを確認する。
  3. 旧 stub と旧孫が消え、新しい stub が 1 本だけ起動していることを確認する。
  4. B を SIGTERM で止める。新しい stub も消え、`center.log` があることを確認する。

```
ok 1 - center を SIGKILL すると rc が孤児で残り、次の center の起動で回収される
# tests 1 / # pass 1 / # fail 0
```

- 後片付けは、記録した pid にだけ SIGKILL を送った（pkill は使っていない）。テスト後に stub と孫が残っていないことを確認した。

## 判断した点

- 対策は task.md の 4 案のうち、次の 3 つを入れた。
  - 全終了経路での子の停止。
  - process group での起動と停止。
  - 起動時の孤児回収。
- 4 案目の desktop の猶予は、既に十分（15 秒）なのでコメントだけにした。
- 孤児の判定に「親が生きている center ではない」という条件は使わず、ppid=1 にした。端末から起動した rc（親はシェル）まで止めないため。
- 照合は `--name <project>` の token 完全一致だけで、他のフラグ（`--continue` 等）は見ない。広いパターンの `pkill -f` を禁止した handoff の Lessons に従った。
- 回収の SIGTERM 猶予は 3 秒の固定値にした（設定項目にはしていない）。
- 子の停止処理と回収処理は、テストで spawn を差し替えた時、既定では `child.kill` と何もしない処理になる。既存テストが実在の process group や同名の project を撃たないため。
- 仕様上の注意: ppid=1 で `--name <project>` が一致すれば、nohup などで手動起動した同名の remote-control も止める。

## 未解決

- 直接の子が自分で先に死んだ場合、その group に残った孫は stop() では止めない。
  - 次の起動時の回収でも対象外になる（孫は pgid≠pid で、argv も `remote-control --name` ではないため）。
- packages/center/README.md と docs/handoff.md は更新していない。reap・center.log・detached の記述が未追加。
- 204 では検証できない項目（mac200 で確認）:
  - 実物の claude が子を持つか。
  - macOS の `ps -ww`。
  - mac 版 bun の EPIPE と ppid の挙動。
- 一時物の残り: `rm` が permission で拒否され、`/tmp/claude-1002/` 直下に次が残っている。前回までの分も残っている。
  - `rc`（調査用。コンパイル済み center 約 82 MB と stub）
  - `rc-orphan-brief.md`

## mac200 で確認すべき項目

- rc の稼働中に `ps -A -o pid,ppid,pgid,command | grep claude` を実行する。
  - 実物の claude が子を持つか。
  - pgid が rc の pid になっているか（0.1.10 では detached 起動のため、そうなるはず）。
- `ps -A -ww -o pid=,ppid=,pgid=,command=` が macOS で動き、出力が想定どおり分解できるか。
- 次のそれぞれの後に desktop を再起動し、`claude remote-control` が project ごとに 1 本だけになるか。
  - アプリ終了（Cmd+Q）。
  - `kill -TERM <app>`。
  - `kill -KILL <app>`。
  - `kill -KILL <center>`。
- 0.1.9 から 0.1.10 に更新した時、0.1.9 が残した孤児（desktop の pgid を共有）が新しい center の起動で回収されるか。
- center の logDir にある `center.log` と `<project>.log` に、`孤児回収` と終了の記録が残るか。
