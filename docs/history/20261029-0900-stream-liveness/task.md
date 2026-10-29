# 指示書: remote-cap と worker の出力を stream-json で受け、生存と進捗を desktop で見られるようにする

- 日付: 2026-10-29 / 発行: Mac main cap
- 実行: 204 remote cap。worker は sonnet か opus（Fable は使わない）。cargo は `CARGO_BUILD_JOBS=2`・`-j 2`、コマンドは逐次。
- 作業 dir: `/home/vagrant/work/bantou/develop`（branch develop）。前提: `docs/concept.md`。

## 目的（ユーザー）

- master-cap が指示を出して報告待ちで止まり、気づくと remote が終わっていた・落ちていた、が多い。
- remote-cap と worker の起動時に出力を stream-json で受け、出力が続いているかを生存の目安にする。server から center / desktop に共有し、bantou 上で作業タスクの内容と、それが動いているかを視覚的に見られるようにする。

## ユーザー確定

- worker の起動は server が行う（A 方式）。cap が自分で worker を報告させる方式（B）はエージェントがやらない場合があり成立しにくいので採らない。
- 「server は worker を起動しない」という従来の決め事は変える。`docs/concept.md` と `docs/architecture.md` を更新する。

## 変更内容

1. server
   - cap に worker 起動の道具を渡す（server の `/mcp` に tool を追加: worker の起動・状態・停止。起動は `claude -p --output-format stream-json`、cap と同じ path 分離・state 管理・孤児回収・process group kill）。cap の prompt / 既定の指示で、worker はこの tool で起動するよう案内する。
   - cap と worker の stream-json を読み続け、要約した活動情報を保持する: 状態（running / idle / done / failed / lost）、最終出力時刻、直近の活動（tool 名、assistant テキストの冒頭など、短く）、現在の作業内容（prompt の冒頭）。
   - 活動情報を center に配信する（protocol `bantou` に通知メッセージを追加し version を上げる。送り先は cap を依頼した center）。一定間隔の要約でよい（全文は流さない）。
   - プロセスが落ちた・出力が一定時間途絶えた場合の状態判定（lost / stalled）。
2. center
   - server からの活動情報を remote ごとに保持し、`remote_list` 等で返す。desktop が取れる形（MCP tool）にする。
3. desktop
   - center の状態画面（または新しい画面）に、remote-cap と worker ごとの作業内容、状態、最終出力からの経過時間を表示。動いている／止まっている／落ちたが一目で分かる表示。自動更新（数秒間隔）。
4. テスト（server・center・desktop Rust・e2e spec）、README、`docs/protocol.md`、`docs/concept.md`（「今は」節）、`docs/architecture.md`。

## 範囲外

- version bump、release、main への push、npm publish。agent-messenger 側の変更（broker の死活監視は別途 agent-messenger に依頼）。

## 確認

- 204 で server を起動し（隔離 broker でよい）、cap が tool で worker を起動 → 活動情報が center に届く → worker を kill すると lost になる、を実測。終わったら止めて後始末。

## 報告

- 同 dir に `report.md`。判断は「概念」か「今は」の実装かを分けて書く。develop に commit・push（push まで必ず）。
