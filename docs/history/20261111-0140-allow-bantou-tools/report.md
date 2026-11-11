# bantou 自身の MCP tool を permission 確認なしで使えるようにする

## 変更
- packages/center/src/wrapper.ts: bantouAllowRules を追加（BANTOU_SERVER_KEY 定数化）
- packages/center/src/remote-control.ts: wrapper 起動の --settings に permissions.allow を追加
- test: remote-control-wrapper.test.ts（既存 3 件の期待を更新、3 件追加）、remote-control.test.ts（rc 直起動 1 件）
- README（packages/center）、docs/design/master-cap-session.md 追記 18

## 許可した tool
- mcp__bantou-messenger__*（常に）
- mcp__bantou__*（MCP 窓口がある時のみ）
- mcp__memory__*（外部記憶がある session のみ）

## 公式 docs の引用（2026-11-11 確認）
- https://code.claude.com/docs/en/permissions
  - "To match every tool from an MCP server, write `mcp__<server>__*`. To match one tool, write its full name, `mcp__<server>__<tool>`."
  - "`mcp__puppeteer` matches any tool provided by the `puppeteer` server" / "`mcp__puppeteer__*` uses wildcard syntax and also matches all tools from the `puppeteer` server"
  - "Allow rules accept tool-name globs only after a literal `mcp__<server>__` prefix. The server segment must be glob-free"
  - "The same holds across settings scopes: if user settings allow a permission and project settings deny it, the deny rule blocks it. The reverse is also true: a user-level deny blocks a project-level allow, because deny rules from any scope are evaluated before allow rules."
  - 名前の変換は "." と空白が "_" になる旨のみ。"-" を含む名前（bantou-messenger）の扱いは明記なし（変換対象に挙がっていないので `mcp__bantou-messenger__*` とした。実機未検証）
- https://code.claude.com/docs/en/settings
  - "When you set the same list key, such as `permissions.allow`, in more than one file, Claude Code combines the lists instead of picking one, so each file can add entries without removing another file's."
  - "--settings: ... Claude Code applies it above your user, project, and local files and below managed settings."

## 判断
- 書式: `mcp__<server>__*`。bare の `mcp__bantou` も docs にあるが、`mcp__bantou-messenger` との前方一致の誤読を避けるため wildcard 形に統一。
- merge: list は連結なので --settings の allow で利用者の allow は置き換わらない。別手段（--allowedTools 等）は不要。
- deny: center は deny を書かない。利用者の deny（例 mcp__bantou__remote_delete）が勝つ。managed の deny も同様。
- rc 直起動（buildRcArgs）: --settings / --mcp-config を渡さず bantou の MCP が付かないので allow も付けない。test で固定。
- 窓口なし（stdio）: mcp__bantou__* は入れない。messenger のみ（--settings は permissions だけになる。従来は --settings 無しだった）。

## test
- typecheck: OK
- npm test: 581 件中 580 pass。失敗 1 = rc-orphan（develop 単体でも同じく失敗を確認）
- protocol の build は通った

## 残課題
- 実機で session の permission 確認が出なくなるかは未検証
- auto mode の分類器が allow rule をどう扱うかの docs 確認は未実施（permissions docs では allow が評価対象としか確認していない）
- bantou-messenger（"-" 入り）の rule が実際に match するかは未検証
