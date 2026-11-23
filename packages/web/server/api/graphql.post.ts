import { defineEventHandler, getRequestHeader, sendStream, setResponseHeaders, setResponseStatus } from "h3";
import { MAX_GRAPHQL_BYTES, readBodyLimited } from "bantou-center-client";
import { getCenterClient } from "../utils/center/client";

// GraphQL（設計書 4 の段階 B）。ブラウザの document を center の /graphql へ、center の token を付けて中継する。
// subscription は SSE（Accept: text/event-stream）なので、応答は溜めずにそのまま流す。token はブラウザへ出さない。
export default defineEventHandler(async (event) => {
  const body = await readBodyLimited(event.node.req, MAX_GRAPHQL_BYTES);
  if (!body.ok) {
    setResponseStatus(event, 413);
    return { errors: [{ message: "body が大きすぎる" }] };
  }
  const reply = await getCenterClient().graphql.forward(body.text, getRequestHeader(event, "accept"));
  event.node.req.on("close", reply.close);
  setResponseStatus(event, reply.status);
  setResponseHeaders(event, { ...reply.headers, "x-accel-buffering": "no" });
  return sendStream(event, reply.body);
});
