import { defineNuxtConfig } from "nuxt/config";

// UI は持たない。Nitro だけを使う headless サーバー
export default defineNuxtConfig({
  compatibilityDate: "2026-10-28",
  ssr: false,
  pages: false,
  devtools: { enabled: false },
  telemetry: false,
  // listen しない（port は内蔵 broker だけが持つ）。bin wrapper が import して起動する
  nitro: { preset: "node-listener" },
  typescript: { typeCheck: false, strict: true },
  runtimeConfig: {
    bantou: {
      // NUXT_BANTOU_CONFIG_PATH（bin wrapper が設定）で上書きされる
      configPath: "",
      // NUXT_BANTOU_PROTOCOL_DIR（bin wrapper が設定）で上書きされる。bantou protocol 定義（protocol.json）の dir
      protocolDir: "",
      // NUXT_BANTOU_SERVER_VERSION（bin wrapper が設定）で上書きされる。この server の npm 版（package.json の version）
      serverVersion: "",
    },
  },
});
