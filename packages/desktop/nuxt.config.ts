// Nuxt 4 SPA served inside the Tauri webview.
// Tauri-specific settings follow https://tauri.app/start/frontend/nuxt/ ;
// `devServer.port` is fixed so `src-tauri/tauri.conf.json > build.devUrl` can point at it.
// Shared screen parts (modules, css, colorMode, fonts, components ...) come from the `../ui` layer.
export default defineNuxtConfig({
  extends: ["../ui"],
  compatibilityDate: "2025-05-15",
  srcDir: "src/",
  devtools: { enabled: false },
  // SPA: `nuxt generate` emits `.output/public/index.html` + client bundles (no SSR).
  ssr: false,
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
