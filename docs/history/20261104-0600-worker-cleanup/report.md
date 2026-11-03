# worker 掃除（report）

## 仕様

- server が、終わった worker の dir（`<workspace>/workers/<id>`）のうち `logs/` と `state.json` 以外を消す。
- 対象: worker が done（report kind=done 後に正常終了）か、worker_stop で止められたもの。条件: その cap が idle（turn 終了）で、かつ worker の終了から `session.workerKeepMs`（既定 30 分）経過。cap の turn 中・その worker に invoke 中の間は消さない。
- 再開（同じ worker_id の worker_start / worker_reply）: 待ち時間を数え直す。掃除中なら完了を待つ。dir が消えた後は clone し直して起動（repo 省略時は `logs/repo.json` の clone 元）。
- 消した事実: server.log（`worker 掃除: worker_id=...`）と、activity の agents[] から外す（protocol は変更なし）。
- 無効化: `session.workerKeepMs: 0`。
- CAP_GUIDE の [worker への指示] に「後始末: 終わったら自分の clone と生成物を自分で消す」を追加（docs/design/cap-orchestration.md が正本、prompts.ts も同じ）。
- server version 0.6.0 → 0.6.1（package.json のみ。bun.lock は commit していない）。

## 変更ファイル

- packages/server/server/utils/bantou/: cleanup.ts（新規）、paths.ts、config.ts、agents.ts、workers.ts、activity.ts、daemon.ts、prompts.ts
- packages/server/package.json、README.md
- packages/server/test/server/utils/bantou/: cleanup.test.ts（新規）、config / activity / prompts のテスト
- docs/architecture.md、docs/design/cap-orchestration.md、本 report

## テスト

- server: npm test 256 件 pass / 0 fail（既存 232 + 新規 24）、typecheck エラー 0。5 回実行して同じ（初回実装時は 248 件、2 回目の修正後は 253 件）。
- 新規: 判定（done / 停止 / idle・failed は対象外 / cap running 中は対象外 / invoke 中は対象外 / 他 cap の持ち主は対象外）、keepMs 0 の無効化、再開による中断（begin で数え直し、判定後・削除前の begin は削除を見送る）、logs の保持、実 git での clone し直し（repo 省略・掃除途中の残骸・記録なしのエラー）、config、activity の forget、他 cap の worker_id では数え直さない。
- center / desktop は未変更のためテストしていない。

## review の指摘と対応

別 agent が diff を読んだ（実行はしていない）。

| 指摘 | 対応 |
|---|---|
| High: 掃除が途中で失敗すると .git だけ消えて印が無く、再開が「git repo でない」で永久に失敗 | 印を先に書き .git を先に消す。clone し直しは先に残骸を消す。テスト追加 |
| High: clone し直しの途中失敗で .git だけ先に移ると、欠けた tree で fetch 経路に進む | .git を最後に移す |
| Medium: 掃除済みで clone 元の記録が無いと、空 dir で黙って走る | 一度は明示エラーにしたが、2 回目の review で撤回（下記） |
| Medium: 他の cap が worker_id を指定して worker_start すると掃除が先延ばしされる | begin を持ち主確認の後へ。テスト追加 |
| Medium: 掃除後の worker_status が state.json 由来で done / 停止が idle に見える。server 再起動で記録が消え掃除されない | 仕様の制限として README に明記。未対応 |
| Low: touched が増え続ける / 未 push・未 commit も消える / repo.json に認証情報が残る | 未対応。README に明記（repo.json は 0600） |
| 確認済み（問題なし）: sweep と worker_start の競合（worker_reply 経路含む）、循環 import、別 dir の誤削除、symlink | — |

## review 2 回目（w-review-wc）の指摘と対応

| 指摘 | 対応 |
|---|---|
| 高: repo 引数なしの worker（dir の中で自分で clone）は repo.json が無く、掃除後の repo なし再開が「記録が無い」エラーで失敗 | 撤回してエラーにしない。repo.json が無い掃除済み worker は clone 元が無いのが正常として、空の dir（logs/ と state.json は残る）で起動する。再開の prompt の末尾に「この dir は掃除されて空。必要なら自分で clone し直すこと」を 1 行足す（manager が prepareDir の結果で付ける最小の変更）。repo.json がある場合は従来どおり clone し直す。cleaned.json の印はそのまま。テスト: repo なしの worker → 掃除 → 同じ id で repo なし worker_start が成功（空 dir・logs/state 残る・prompt に注記）。repo 付きの clone し直しのテストは維持 |
| 中: 掃除失敗が毎分ログに出続ける | 同じ worker・同じ理由は 1 回だけ出し、成功か再開（begin）で出し直す。テスト追加 |
| 中: owner.json が無い worker が黙って永久に残る | 掃除しないまま、worker ごとに 1 回だけ「持ち主記録が無いので掃除しない: <id>」を出す。テスト追加 |
| 低: touched が増え続ける | 掃除成功時に消す。sweep ごとに keepMs を過ぎたものも落とす（判定に効かないため）。観測できる挙動が変わらないので専用テストは無し（判定のテストが通ること） |
| 低: logs が symlink だと印の書き込みが dir の外へ出る | cleanWorkerDir の先頭で logs が通常の directory（または無い）ことを lstat で確認し、違えば何も消さず投げる（失敗としてログ）。cleaned.json が symlink でも先を書かず、印そのものを置き換える。テスト追加（2 件） |

## review 3 回目（w-review-wc）の指摘と対応

| 指摘 | 対応 |
|---|---|
| 中: 空 dir 再開の注記が再開後も毎回付く（repo 無し worker は .git が無いのが常態で、cleaned.json が残ると以後ずっと isCleaned=true） | 空の dir で起動する時点で cleaned.json を外す（掃除途中の残骸も先に消す）。注記は掃除後の最初の再開 1 回だけ。次に掃除が走れば cleanWorkerDir が印を書き直す。テスト: repo 無し start(p1) → 掃除 → p2（注記あり）→ 自作 → p3（注記なし・作業物そのまま）→ 掃除 → p4（注記あり）→ p5（注記なし）で prompts と dir を確認 |
| 低: 印が残った repo 無し worker に repo 付き start が来ると recloneInto が自作物を消す | 印が外れるので reclone に入らない（従来どおり「git repo でない」で失敗し、自作物は残る）。確認テスト 1 件 |
| 低: noOwnerLogged / lastFailure が溜まる | 掃除成功時に消し、sweep で activity から外れた worker 分も落とす。外れて戻ったら出し直す。テスト 1 件 |

## (3) 一覧（読むだけ。何も消していない）

取得時: 2026-11-03 21:0x（204）。最終更新は dir の mtime（state.json の時刻ではない）。

### workers/

| id | 最終更新（dir の mtime） | state | du -sh |
|---|---|---|---|
| w-1579faec2d | 2026-11-03 05:51 | idle | 528M |
| w-292bd2db53 | 2026-11-03 17:03 | idle | 5.9G |
| w-2a16c37efa | 2026-11-03 17:46 | idle | 348K |
| w-474a2ca4b7 | 2026-11-03 05:11 | idle | 525M |
| w-4a1ce46eca | 2026-11-03 17:53 | idle | 8.4M |
| w-5749c93792 | 2026-11-03 16:23 | idle | 5.9G |
| w-769559cae3 | 2026-11-03 13:03 | idle | 5.9G |
| w-7c8dc2efb1 | 2026-11-03 16:06 | idle | 5.9G |
| w-7f3d43813e | 2026-11-03 17:51 | idle | 8.4M |
| w-9afea53e25 | 2026-11-03 03:01 | idle | 128K |
| w-a0b2dfc404 | 2026-11-03 17:50 | idle | 6.0G |
| w-a5fc578b08 | 2026-11-03 16:18 | idle | 5.9G |
| w-a698f99d6b | 2026-11-03 16:34 | idle | 5.9G |
| w-a8ffae442c | 2026-11-03 17:59 | idle | 9.0M |
| w-center | 2026-11-03 18:32 | idle | 527M |
| w-cps | 2026-11-03 21:07 | running | 536M |
| w-ctx | 2026-11-03 19:08 | idle | 5.8G |
| w-d5a6d0cb4d | 2026-11-03 17:33 | idle | 5.9G |
| w-d608383041 | 2026-11-03 03:10 | idle | 524M |
| w-desktop | 2026-11-03 18:22 | idle | 5.9G |
| w-doc-install | 2026-11-03 19:30 | idle | 8.9M |
| w-e2ab838648 | 2026-11-03 17:45 | idle | 196K |
| w-f13ab3d8bd | 2026-11-03 05:23 | idle | 5.9G |
| w-fe32e87a91 | 2026-11-03 17:55 | idle | 5.9G |
| w-fix | 2026-11-03 20:10 | idle | 531M |
| w-install202 | 2026-11-03 20:57 | idle | 216K |
| w-merge | 2026-11-03 19:00 | idle | 5.9G |
| w-model-bantou | 2026-11-03 04:52 | idle | 534M |
| w-model-server | 2026-11-03 04:56 | idle | 776K |
| w-proto-server | 2026-11-03 18:15 | idle | 528M |
| w-review | 2026-11-03 18:42 | idle | 5.8G |
| w-review-d | 2026-11-03 20:08 | idle | 912K |
| w-review-m | 2026-11-03 20:33 | idle | 532K |
| w-review-si | 2026-11-03 19:44 | idle | 776K |
| w-si-center | 2026-11-03 19:41 | idle | 528M |
| w-si-desktop | 2026-11-03 19:41 | idle | 6.1G |
| w-si-merge | 2026-11-03 20:35 | idle | 5.9G |
| w-sp-center | 2026-11-03 20:56 | idle | 526M |
| w-sp-desktop | 2026-11-03 21:07 | running | 5.8G |
| w-wclean | 2026-11-03 20:56 | running | 527M |

### caps/（参考）

| id | 最終更新（dir の mtime） | state | du -sh |
|---|---|---|---|
| c-8c62edb0f5 | 2026-11-03 21:08 | running | 4.4M |
| r-0ca3c1e00f | 2026-11-03 03:10 | idle | 168K |
| r-0fb0b44605 | 2026-11-03 03:01 | idle | 164K |
| r-12c394ff25 | 2026-11-03 17:03 | idle | 184K |
| r-173cbf62bf | 2026-11-03 17:59 | idle | 376K |
| r-29148a9a51 | 2026-10-28 22:48 | idle | 100K |
| r-2ba6f0dad1 | 2026-10-28 21:43 | idle | 100K |
| r-467a42770b | 2026-10-28 22:48 | idle | 92K |
| r-49c2b0db98 | 2026-11-03 13:03 | idle | 232K |
| r-6537bdc6c8 | 2026-11-03 17:55 | idle | 184K |
| r-690600fb0c | 2026-11-03 18:42 | idle | 608K |
| r-6d853e802d | 2026-11-03 16:19 | idle | 180K |
| r-6fa217d270 | 2026-11-03 16:34 | idle | 176K |
| r-72b809bf23 | 2026-11-03 05:51 | idle | 172K |
| r-73a256c766 | 2026-11-03 17:50 | idle | 180K |
| r-88881032f0 | 2026-11-03 16:23 | idle | 180K |
| r-8f6d41d4c3 | 2026-10-28 21:43 | idle | 88K |
| r-a7f9373542 | 2026-11-03 04:56 | idle | 304K |
| r-ab51f6e4be | 2026-11-03 05:11 | idle | 172K |
| r-be56135d92 | 2026-11-03 05:23 | idle | 172K |
| r-d64f8fe2a4 | 2026-11-03 17:34 | idle | 236K |
| r-e52a209893 | 2026-11-03 17:46 | idle | 304K |
| r-e8f791d119 | 2026-11-03 16:06 | idle | 188K |
| r-efa2ab22f2 | 2026-11-03 03:03 | idle | 120K |

合計（du -sh）: 93G workers / 9.0M caps

注: w-wclean（本 worker）と w-cps、w-sp-desktop は取得時に running。dir 作成後すぐの取得で、サイズは work 中に変わる。

## 残存物

- 一時物: 作業 dir 内の tmp は作っていない（テストは OS の tmpdir 内の mkdtemp を各テストが rm）。clone 自体（packages 配下の node_modules 含む）は作業 dir に残る。
- 未対応: server 再起動前に終わった worker は掃除されない／掃除後の worker_status の見え方／touched の増加／未 push 作業の確認なし。
- 実機（204）での常駐 server による掃除の動作は未確認（単体テストと実 git のテストのみ）。
