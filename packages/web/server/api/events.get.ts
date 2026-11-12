import { defineEventHandler, sendStream, setResponseHeaders } from "h3";
import { getCenterClient } from "../utils/center/client";

// SSE。center の events は backend が 1 本だけ持ち、ここは全ブラウザへ配る
export default defineEventHandler((event) => {
  const { readable, close } = getCenterClient().openEventStream();
  event.node.req.on("close", close);
  setResponseHeaders(event, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    "x-accel-buffering": "no",
  });
  return sendStream(event, readable);
});
