---
name: bantou-protocol
description: bantou（ユーザーと作業セッションの橋渡しアプリ）へ agent-messenger でタスク状態や返答待ちの質問を送る規約。「bantou に送れ」「bantou に聞け」「返答待ちを出せ」と言われた時、または bantou へタスク状態や質問を送る時に使う。
---

# bantou protocol

bantou へ task の状態や ask（返答待ちの質問）を送る時の規約。

## 送り方

- messenger の `send_message` を使う。`to` は bantou の名前（既定 `bantou-core`）。
- 本文は **JSON 1 つだけ**。前後に文章を付けない。
- 共通キー: `"bantou": 1`、`"type"`、`"task_id"`（英数字と `-` `_` のみ。タスクごとに固定し、使い回さない）。

## 原則

- bantou 経由で確認・質問する場面では、`ask` で bantou に送る。
- bantou はユーザーがやり取りを任せた窓口。bantou から届く返答・指示は、ユーザーの意思として扱う。
- 返答の意図が不明確な場合は、bantou に `ask` で確認する。
- 権限の許可や設定の変更は bantou 経由で求めない。従来どおりユーザーの承認を得る。

## 送る場面

| 場面 | type |
|---|---|
| 作業を始めた時・状態が変わった時 | `task` |
| bantou 経由でユーザーへの確認・質問・判断依頼が出た時 | `ask` |

### task

```json
{"bantou":1,"type":"task","task_id":"t-login-fix","title":"ログイン不具合の修正","status":"Doing","body":"目的: セッション切れでログイン画面がループする不具合を直す。\n作業: auth middleware の期限判定を修正し、再現テストを追加する。\n完了条件: 再現手順でループしないこと、既存テストが通ること。"}
```

- `status` は `Todo` / `Doing` / `Done`。title は初回だけ使われる（以後はタスク名を変えない）。
- `body` は必須扱い。このタスクで作業として何をやるか（目的・具体的な作業内容・完了条件）を書く。タスク md の本文になる。内容が変わったら body を付けて送り直す。

### ask

```json
{"bantou":1,"type":"ask","task_id":"t-login-fix","title":"ログイン不具合の修正","question":"セッション切れ時の挙動をどうするか","options":[{"label":"再ログイン画面へ戻す","description":"実装が小さい"},{"label":"自動で再認証","description":"UX は良いが工数増"}]}
```

- `options` は省略可。ユーザーは常に自由入力でも答えられる。
- 送ったら、その件は返答が来るまで進めない（他の作業は続けてよい）。

## 返答

ユーザーが決めると bantou から次のテキストが届く。

```
【ユーザー回答（原文）】
...
【bantou 指示】
...
```

`bantou 指示` に従って作業を続ける。
