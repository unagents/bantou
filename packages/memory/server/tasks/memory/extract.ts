import { defineTask } from "nitropack/runtime";
import { getRuntime } from "../../utils/runtime";
import { runCycle } from "../../utils/worker";

// 未処理 event を agent ごとにまとめて chatp に投げ、候補を検証して memory_items に登録する。
// その後、埋め込み未設定の item を Ollama で小分けに埋める（1 回の run の時間に上限。残りは次の run）。
// 件数が動いた時と error の時は log に出す（runCycle）。
export default defineTask({
  meta: { name: "memory:extract", description: "event から記憶候補を抽出し、検証して登録・埋め込みする" },
  async run() {
    let rt;
    try {
      rt = await getRuntime();
    } catch (e) {
      // 起動時の検査（DB 接続・role・次元）の失敗も log に残す
      console.warn(`[memory] run error: ${e instanceof Error ? e.message.slice(0, 200) : String(e)}`);
      throw e;
    }
    const r = await runCycle({ db: rt.db, embedder: rt.embedder, chat: rt.chat, extractBatch: rt.extractBatch, embed: rt.embed, gate: rt.gate });
    return { result: r };
  },
});
