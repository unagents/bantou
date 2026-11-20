import { defineTask } from "nitropack/runtime";
import { runExtractTask } from "../../utils/tasks";

// 未処理 event を agent ごとにまとめて chatp に投げ、候補を検証して memory_items に登録する。
// 埋め込みは別の task（memory:embed）。抽出が長引いても埋め込みを待たせない。
// 件数が動いた時と error の時は log に出す（runExtractCycle）。配線は server/utils/tasks.ts（runExtractTask）。
export default defineTask({
  meta: { name: "memory:extract", description: "event から記憶候補を抽出し、検証して登録する" },
  async run() {
    return { result: await runExtractTask() };
  },
});
