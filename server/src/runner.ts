import { runClaude, type ClaudeRunOptions, type ClaudeRunResult } from "./claude.js";

/** claude の 1 回実行を担う差し替え口。 */
export interface AgentRunner {
  run(o: ClaudeRunOptions): Promise<ClaudeRunResult>;
}

/** claude -p を子プロセスで起動する方式。 */
export const cliRunner: AgentRunner = { run: runClaude };

/** claudep 方式（Agent SDK query()）。interface のみ。未実装。 */
export const claudepRunner: AgentRunner = {
  run: async () => {
    throw new Error("claudep runner は未実装");
  },
};
