# 報告: guardrail を廃止する

- 日付: 2026-10-31 / 実行: 204 remote cap（branch `develop`、worktree なし）
- worker: sonnet 1 本（Fable 不使用）。commit・push は cap が実施。

## commit

- 本 report と task.md を含む 1 commit（push 時の HEAD）。

## 変更内容への対応

1. 削除: `plugin/bantou/hooks/hooks.json`、`plugin/bantou/scripts/guard.mjs`、`docs/guardrail.md`（`git rm`）。`plugin/bantou/` は `skills/` のみになった。
2. `plugin/bantou/.claude-plugin/plugin.json`: hooks を指すキーは元々無く、description の guardrail hooks の記述を外した（JSON.parse で valid を確認）。`skills/bantou-protocol/SKILL.md`: 「登録通知」と「直接質問しない・AskUserQuestion 禁止」の原則を外した。`task` / `ask` / `ping` の説明は残した。
3. 参照の更新:
   - `CLAUDE.md`、`README.md`、`server/README.md`: `docs/guardrail.md` への参照を削除。
   - `docs/architecture.md`: plugin の説明を「bantou-protocol skill」のみに変更。
   - `docs/protocol.md`: Storage 表から `sessions.json`（roster）行を削除。
   - `docs/handoff.md`: Storage の `sessions.json`、Open の guardrail 記述、Lessons の「登録されたら `ask` で送れ」を削除。
   - `docs/history/` は無改変。
4. grep（`guardrail|guard.mjs|sessions.json`、`docs/history`・`node_modules`・`.git` 除外）: `guardrail` と `guard.mjs` のヒットは 0 件。`sessions.json` のヒットは次のとおり。
   - center の保存（残すもの）: `packages/center/README.md`、`packages/center/src/daemon.ts`、`packages/center/test/sessions.test.ts`、`docs/design/center-tools.md`。
   - desktop 名簿の意味で残るもの: `packages/protocol/src/paths.ts` の `sessionsPath`（コメント「Registered sessions (roster)」）と `packages/protocol/test/protocol.test.mjs` の assert。task の変更対象（1〜3）に含まれないコードなので、未変更で残した。

## 要確認・未解決

- `packages/protocol/src/paths.ts` の `sessionsPath` と、そのテストの assert 1 件。参照はテストだけ。削除するかの判断が要る。
- `docs/handoff.md` の Decisions / Open に「Session add: pick from broker peer list」「Registered sessions …」の記述がある。セッション追加の統一以前の内容とみられるが、guardrail の範囲外なので未変更。
- `docs/protocol.md` と desktop（`session.rs`、`useBoard.ts` など）に「registered」の表現が残る。名簿とは別の用語の可能性があり、未変更。
- テストは未実行（変更はドキュメントと plugin のみで、コードは変えていない）。

## 後始末

- worker の一時ファイル: なし。
- 起動したプロセス・ポート: なし。
- 残置: 作業開始前からある untracked ファイル（`.bashrc` など、`server/package-lock.json`）は無関係のため触っていない。
