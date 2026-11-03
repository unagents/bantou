import { unwatchFile, watchFile } from "node:fs";
import { loadConfig } from "./config.js";

/**
 * config ファイルの更新を見て、sessionInstructions だけを反映する（他の項目は center の再起動で反映する）。
 * 読めない・不正な config は無視して前の内容のまま（log に出す）。戻り値は監視の停止。
 */
export function watchSessionInstructions(opts: {
  path: string;
  /** 起動時点の値。同じ内容なら onChange を呼ばない。 */
  initial: string | undefined;
  onChange: (text: string | undefined) => Promise<void>;
  log: (m: string) => void;
  intervalMs?: number;
}): () => void {
  let current = opts.initial;
  let busy = false;
  const listener = (): void => {
    if (busy) return;
    busy = true;
    void (async () => {
      try {
        const next = (await loadConfig(opts.path)).sessionInstructions;
        if (next === current) return;
        current = next;
        await opts.onChange(next);
      } catch (e) {
        opts.log(`config の再読込失敗（指示は前の内容のまま）: ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        busy = false;
      }
    })();
  };
  watchFile(opts.path, { interval: opts.intervalMs ?? 1000, persistent: false }, listener);
  return () => unwatchFile(opts.path, listener);
}
