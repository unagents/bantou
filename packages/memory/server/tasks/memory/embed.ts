import { defineTask } from "nitropack/runtime";
import { getRuntime } from "../../utils/runtime";
import { runEmbedCycle, runTaskSafely } from "../../utils/worker";

// 埋め込み未設定の item を Ollama で小分けに埋める（1 回の run の時間に上限。残りは次の run）。
// 抽出（memory:extract）とは別の task。Nitro は別名の task を並行に動かすので、chatp が遅い間も毎分進む。
// 件数が動いた時と error の時は log に出す（runEmbedCycle）。
export default defineTask({
  meta: { name: "memory:embed", description: "埋め込み待ちの記憶を小分けに埋め込む" },
  async run() {
    const result = await runTaskSafely(async () => {
      const rt = await getRuntime();
      return runEmbedCycle({ db: rt.db, embedder: rt.embedder, embed: rt.embed, gate: rt.gate });
    });
    return { result };
  },
});
