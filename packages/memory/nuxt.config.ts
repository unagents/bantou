import { defineNuxtConfig } from "nuxt/config";

// UI は持たない。Nitro だけを使う headless な MCP server
// 設定は環境変数（MEMORY_TOKEN / MEMORY_DATABASE_URL / OLLAMA_URL / CHATP_URL …）。README 参照
export default defineNuxtConfig({
  compatibilityDate: "2026-10-28",
  modules: ["@nuxtjs/mcp-toolkit"],
  ssr: false,
  pages: false,
  devtools: { enabled: false },
  telemetry: false,
  typescript: { typeCheck: false, strict: true },
  mcp: {
    name: "bantou-memory",
    route: "/mcp",
  },
  nitro: {
    experimental: { tasks: true },
    // 抽出 worker を 1 分ごとに起動（未処理 event が無ければ何もしない）
    scheduledTasks: { "* * * * *": ["memory:extract"] },
  },
});
