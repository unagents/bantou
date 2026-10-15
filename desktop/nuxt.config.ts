// Nuxt 4 SPA served inside the Tauri webview.
// Tauri-specific settings follow https://tauri.app/start/frontend/nuxt/ ;
// `devServer.port` is fixed so `src-tauri/tauri.conf.json > build.devUrl` can point at it.
export default defineNuxtConfig({
  compatibilityDate: "2025-05-15",
  devtools: { enabled: false },
  modules: ["@nuxt/ui", "unplugin-fonts/nuxt"],
  css: ["~/assets/css/main.css"],
  // SPA: `nuxt generate` emits `.output/public/index.html` + client bundles (no SSR).
  ssr: false,
  // Cork (the app this UI is ported from) is dark-only; `@nuxtjs/color-mode`
  // (wired in by @nuxt/ui) defaults `preference` to "system" — pin it to
  // "dark" so the app doesn't follow the OS/browser scheme. No colorMode
  // toggle exists in the UI, so this is effectively a fixed dark theme.
  colorMode: {
    preference: "dark",
    fallback: "dark",
  },
  // Loads the Cork font stack (`--font-sans` / `--font-display` in
  // app/assets/css/main.css) via the Fontsource provider; requires the
  // `@fontsource-variable/inter` / `@fontsource-variable/space-grotesk`
  // packages (see package.json).
  unfonts: {
    fontsource: {
      families: ["Inter Variable", "Space Grotesk Variable"],
    },
  },
  devServer: {
    host: "0",
    port: 1420,
  },
  vite: {
    // Better support for Tauri CLI output
    clearScreen: false,
    // Enable environment variables
    envPrefix: ["VITE_", "TAURI_"],
    server: {
      // Tauri requires a consistent port
      strictPort: true,
    },
  },
  // Avoids error [unhandledRejection] EMFILE: too many open files, watch
  ignore: ["**/src-tauri/**"],
});
