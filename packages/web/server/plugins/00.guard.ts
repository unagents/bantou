import { defineNitroPlugin } from "nitropack/runtime";
import { createGuardHandler, guardFromEnv } from "../utils/guard/handler";

// 守りは全ての要求の一番手前に置く。Nitro は静的 asset（SPA の HTML・/_nuxt/*・public/）を server middleware より先に
// 応答するので、middleware では静的 asset が守りの外に出る（3a の review）。h3 の stack の先頭に積めば、静的配信より
// 先に走る（静的配信は stack の先頭の middleware として積まれる）。守りを通らない経路は残さない。
export default defineNitroPlugin((nitro) => {
  nitro.h3App.stack.unshift({ route: "/", handler: createGuardHandler(() => guardFromEnv()) });
});
