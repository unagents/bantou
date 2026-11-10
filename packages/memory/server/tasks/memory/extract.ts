import { defineTask } from "nitropack/runtime";
import { embedPending } from "../../utils/embed";
import { extractAll } from "../../utils/extract";
import { getRuntime } from "../../utils/runtime";

// 未処理 event を agent ごとにまとめて chatp に投げ、候補を検証して memory_items に登録する。
// その後、埋め込み未設定の item を Ollama で埋める。
export default defineTask({
  meta: { name: "memory:extract", description: "event から記憶候補を抽出し、検証して登録・埋め込みする" },
  async run() {
    const rt = await getRuntime();
    const { results, errors } = await extractAll(rt.db, { chat: rt.chat, batchSize: rt.extractBatch });
    const embedErrors: { agentId: string; message: string }[] = [];
    const agents = (await rt.db.query<{ id: string }>("SELECT id FROM agents")).rows;
    for (const a of agents) {
      try {
        await embedPending(rt.db, a.id, rt.embedder);
      } catch (e) {
        embedErrors.push({ agentId: a.id, message: e instanceof Error ? e.message : String(e) });
      }
    }
    return { result: { results, errors, embedErrors } };
  },
});
