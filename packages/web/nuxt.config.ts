import { defineNuxtConfig } from "nuxt/config";

// 3a: UI は持たない。守りを載せる Nitro server だけ（画面は 5a 以降）
export default defineNuxtConfig({
  compatibilityDate: "2026-10-28",
  ssr: false,
  pages: false,
  devtools: { enabled: false },
  telemetry: false,
  typescript: { typeCheck: false, strict: true },
});
