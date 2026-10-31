# 指示書: guardrail を廃止する

- 日付: 2026-10-31 / 発行: Mac main cap
- 実行: 204 remote cap。worker は sonnet（Fable は使わない）。
- 作業 dir: `/home/vagrant/work/bantou/develop`（branch develop）。

## ユーザー確定

guardrail（登録済み session がユーザーに直接質問するのを hook で止める仕組み）は、今の構成では不要なので廃止する。
- 理由: master-cap は `claude remote-control` でユーザーと直接話すので、直接の質問は正しい動き。remote-cap / worker は `claude -p` で質問の手段が無い。判断に使っていた名簿 `sessions.json` も、セッション追加の統一で書かなくなった。

## 変更内容

1. 削除: `plugin/bantou/hooks/hooks.json`、`plugin/bantou/scripts/guard.mjs`、`docs/guardrail.md`。
2. `plugin/bantou/.claude-plugin/plugin.json` から hooks の参照を外す。plugin に skill（`bantou-protocol`）だけが残る形にする。skill の中身で guardrail / 登録通知 / `sessions.json` に触れている所があれば、今の仕様に合わせて直す（MVP の `task` / `ask` / `ping` の説明は残す）。
3. 参照の更新: `CLAUDE.md`、`README.md`、`server/README.md`、`docs/handoff.md`、`docs/architecture.md`、`docs/protocol.md`（`sessions.json`、登録通知、guardrail の記述）。`docs/history/` は触らない。
4. grep で `guardrail`、`guard.mjs`、`sessions.json`（desktop の名簿の意味のもの）が残っていないことを確かめる。center の `sessions.json`（center が起動した session の保存）は別物なので残す。

## 範囲外

- version bump、release、main への push。

## 報告

- 同 dir `docs/history/20261031-1700-retire-guardrail/` に `report.md`。後始末は自分で行い、残ったものを列挙。develop に commit・push（push まで必ず）。
