# fix: master-cap の session 名を `<project 名>-cap` にする

## 解釈
変えるのは (a) Claude に渡す名前と (b) messenger の peer 名。(c) 内部の識別子は変えない。調べた結果、この解釈で成り立つ（内部 key まで変える必要は無い）。

## 利用者の意図（補足）
remote の session 一覧で、center が起動した master-cap の session を見分けられるようにする。project 名そのものは変えず、「session の名前」だけに `<project>-cap` を当てる。project 名を key にした紐付けは変えない。名前が変わる影響は運用で補い、互換の別名・移行の処理は作らない。

## 対象ごとの判断
| 対象 | 場所 | 判断 | 理由 |
|---|---|---|---|
| remote-control 一覧の名前 | `claude --remote-control <名>`（wrapper.ts buildWrapperArgs）、旧経路 `claude remote-control --name`（buildRcArgs） | **変えた** `<project>-cap` | 目的そのもの。表示名で、他の記録の key に使われていない |
| messenger 登録名 | `--mcp-config` の `AGENT_MESSENGER_NAME`（mcpConfigJson） | **変えた** | center が起動時に決める session を指す名前。code を確かめた結果、remotes.json・sessions.json・cap_id・memory はどれも project 名（session）で持ち、messenger 名は保存されていない（通知のたびに導出）。project 名を key にした紐付けには当たらない |
| daemon notify の宛先引き | daemon.ts notify → notifyPeer（peer 名で引く） | **変えた**（新名だけで引く。旧名への fallback は外した） | 宛先は messenger 名なので、登録名と同じ関数で導出する。owner（= session = project 名）自体は変えない |
| 起動時の指示文 | system-instructions.ts master-cap-role「session「…」」 | **変えた**（`<project>-cap`、role@4） | session を指す所。実際に付く名前と一致させる。project を指す所は無い |
| sessions.json の key / session 名 | sessions.ts, project-settings.ts | 変えない | project 名を key とする内部の識別子 |
| remote の cap_id `c-<center-id>-<session>`、remotes.json の session | center-id.ts, remotes.ts | 変えない | server 側の cap の記録との対応が切れる |
| 作業 dir・log 名 | remote-control.ts（`<project>.log`） | 変えない | 既存の file との対応 |
| memory の agent ID（X-Agent-Id） | wrapper.ts mcpConfigJson | 変えない | 記憶との対応 |
| bantou MCP の X-Bantou-Session・session token | wrapper.ts / session-auth.ts | 変えない | center の内部の識別子（tool の owner の特定） |
| desktop の操作の引数・tool（remote_send 等）が受ける session 名 | desktop / tools.ts | 変えない | 内部の識別子 |

変換は `src/session-name.ts` の `capSessionName(project)` 1 か所。`-cap` で終わる名前は重ねない。messenger 名は center が env で決めるので、Claude に set_name させる方式は採らない。

## 運用で補う事（互換の別名・移行は作っていない）
- 変わる名前: remote-control 一覧の session 名と messenger の peer 名が `<project>` から `<project>-cap`（例 bantou → bantou-cap）になる。
- いつ変わるか: center（または app）を更新して再起動した後、master-cap の session が次に起動された時（session の再起動・`session_create`・center 再起動で session を立て直す時）。起動済みの session は再起動するまで旧名のまま。
- 古い名前を宛先にしている物: center が master-cap へ push する完了通知は、center 更新後は新名だけで引く。再起動前の旧名の session には届かない（center.log に「messenger に peer …-cap がいない」と出る）。この時は session を再起動して新名にするか、`remote_wait` / `remote_list` で結果を確かめる。他の session や peer が旧名で master-cap へ送っている場合も、再起動後は届かないので宛先を新名へ更新する。
- 確認の仕方: Claude の remote-control の session 一覧で `<project>-cap` が見える事、`list_peers` で `<project>-cap` が見える事、center.log の通知の送信結果（`送れた／peer がいない`）。
- 変わらない物: sessions.json、cap_id、remotes.json、作業 dir、log、memory の対応。移行は不要。

## test
- packages/center typecheck: 通る。
- packages/center test: 624 件中 623 pass・1 fail。fail は既知の不安定 test「center を SIGKILL すると rc が孤児で残り…」で、単独再実行では pass（1/1）。
- 追加・更新した test: `capSessionName`（session-name.test.ts。`-cap` を重ねない）、起動引数の `--remote-control <session>-cap` と `-cap` で終わる名前を重ねない事、messenger の `AGENT_MESSENGER_NAME`、X-Bantou-Session / X-Agent-Id / token / status が session 名のままである事（remote-control-wrapper.test.ts）、旧経路の `--name`、指示文の名前と role@4（system-instructions.test.ts）、cap_id が変わらない事。
- desktop: 変更が無い（画面は session 名＝内部の識別子を使い続ける）ので typecheck・e2e は回していない。
- daemon の notify（新名だけで引く）の単体 test は無い（daemon の組み立て内。`notifyPeer` 自体の test は既存）。
