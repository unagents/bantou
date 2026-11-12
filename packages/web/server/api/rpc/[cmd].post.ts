import { defineEventHandler, getRouterParam, setResponseHeader, setResponseStatus } from "h3";
import { readBodyLimited } from "bantou-center-client";
import { getCenterClient } from "../../utils/center/client";

// 中身は center-client の rpc。command 名の許可リスト・引数・伏せ字はそちらにある
export default defineEventHandler(async (event) => {
  const cmd = getRouterParam(event, "cmd") ?? "";
  // 上限は読み込み中に守る（Content-Length 超過は読まない）
  const body = await readBodyLimited(event.node.req);
  if (!body.ok) {
    setResponseStatus(event, 413);
    setResponseHeader(event, "connection", "close");
    return { error: "body が大きすぎる" };
  }
  const r = await getCenterClient().rpc(cmd, body.text);
  setResponseStatus(event, r.status);
  return r.body;
});
