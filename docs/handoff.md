# bantou handoff (2026-09-30)

Resume notes for the session developing bantou (compact / session switch).

## State

- Repo: `~/work/desktop/bantou`, Gitea `agent-hand/bantou` (main / develop, latest `cc23003`, v0.1.2).
- Installed on this Mac via Homebrew: `/opt/homebrew/bin/brew` (NOT `/usr/local/bin/brew`, Intel), tap `agent-hand/bantou`, `brew upgrade --cask bantou`.
- bantou is running on the workspace `~/valut/20_Project/99_Progress` and is registered on the 202 broker as `bantou-core` (found by messenger's own discovery order).
- This dev session is registered to bantou as session `bantou` (messenger `set_name bantou`; name is lost on `/mcp` reconnect or restart).
- Cork MCP `cork-99_Progress` is added (local scope, this project).

## Dev flow (agreed)

- Implement locally. E2E (Playwright + mocked Tauri IPC) runs on mac200 only: rsync (exclude node_modules, target, .nuxt, .output, .git) to `claude-cli@192.168.1.200:work/bantou/`, then `bun run e2e`. Chrome-launch flakes absorbed by retries are known.
- Rust: `cargo test` locally. Live tests (`--ignored`) need a test broker; never register a second `bantou-core` on the shared 202 broker.
- Release: bump `package.json` + `src-tauri/Cargo.toml`, commit develop, ff main, push, `CI=true bun run tauri build`, Gitea release with dmg, `scripts/publish-cask.sh`, then `brew upgrade --cask bantou`.
- Web-only dev (nuxt dev on 204) was rejected: backend would be mocked.

## Decisions (user)

- Board: registered sessions only, as rows; tasks indented under the session; working first, queued below, done folded.
- Session add: pick from broker peer list; unnamed peers get a name at registration (set_name instruction sent).
- Task add: icon-only button on each session row (sends an add-task instruction to that session). No header task button.
- Status: read-only in the UI; only sessions change it via `task` messages.
- Storage: nothing in the workspace except Cork task md. bantou data in `~/.local/share/bantou/<workspace path with / → ->/` (`sessions.json`, `threads/`, `inbox.jsonl`). No bantou connection setting.
- Task envelope has `body` (goal / work / done condition).
- IME: Enter that confirms Japanese conversion must not send.

## Open

- Registered sessions do not all follow the protocol: crawling-cap refuses rules delivered by another session (Claude Code safety). My decision (not yet built): session-side join — user types `/bantou-join` in the work session; the session sets its name and sends a join to bantou; bantou registers it and replies with the protocol.
- Guardrail hooks + `bantou-protocol` skill exist in `plugin/bantou/` (see `docs/guardrail.md`) but are NOT installed. The user said hooks/skills were not permitted; installing is a Claude Code config change and needs the user's direct approval.
- Rust commands `create_task` / `update_task_status` are no longer used by the UI (still registered).
- Icons are fetched at runtime from `api.iconify.design`.

## Lessons from this session (do not repeat)

- Registered to bantou: send confirmations/questions to `bantou-core` as `ask`, not in the terminal. Only permission/config changes are asked directly.
- Do not register non-work as tasks (umbrella names, "waiting for decision"). A task = concrete work with body. All my earlier task md were deleted on user request.
- Do not push decisions to the user that can be made from evidence; decide, state the basis, act.
- Do not invent settings/specs (config files, storage) without agreement.
- Never `pkill -f` a broad pattern (killed every local messenger MCP once). Stop processes by PID.
- Classifier denials (Create Public Surface / Permission Grant / Auto-Mode Bypass) apply to the outcome; do not retry via other routes. See vault `99_System/postmortem/2026-09-25-classifier-excuse-careery.md` for the order of alternatives.
- Screen: this Mac's terminal has no Screen Recording / Accessibility; verify UI by headless render (Playwright + mock) and look at the screenshot yourself before reporting.
