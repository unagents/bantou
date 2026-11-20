import { defineNuxtConfig } from "nuxt/config";

// bantou の web アプリ。画面部品は packages/ui（Nuxt layer）から取り込み、~/tauri（HTTP transport と browser 用 platform）は
// このアプリの app/tauri/ が供給する。ssr:false の SPA で、守り（server/plugins/00.guard.ts）が SPA の配信も含めて全要求の前に立つ。
export default defineNuxtConfig({
  extends: ["../ui"],
  compatibilityDate: "2026-10-28",
  // The ui layer sets srcDir "." (its parts sit at its root); this app keeps its own under app/ (like desktop's src/).
  srcDir: "app/",
  ssr: false,
  devtools: { enabled: false },
  telemetry: false,
  app: { head: { title: "bantou", meta: [{ name: "viewport", content: "width=device-width, initial-scale=1, viewport-fit=cover" }] } },
  typescript: { typeCheck: false, strict: true },
});
