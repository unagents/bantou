import { defineEventHandler, getRouterParam, readRawBody, setResponseStatus } from "h3";
import { getCenterClient } from "../../utils/center/client";

// 中身は center-client の rpc。command 名の許可リスト・引数・伏せ字はそちらにある
export default defineEventHandler(async (event) => {
  const cmd = getRouterParam(event, "cmd") ?? "";
  const body = (await readRawBody(event, "utf8")) ?? "";
  const r = await getCenterClient().rpc(cmd, body);
  setResponseStatus(event, r.status);
  return r.body;
});
