// Nuxt 4 layer shared by packages/desktop (and, later, packages/web).
// Holds the screen parts (components / composables / types / api / assets);
// it must not depend on Tauri packages. A consumer provides `~/tauri` (see api/*.ts).
import { join } from "node:path";

const currentDir = import.meta.dirname;

export default defineNuxtConfig({
  compatibilityDate: "2025-05-15",
  // The layer keeps components/ composables/ ... at the package root (no src/ or app/).
  srcDir: ".",
  // Named alias for consumers: `~/` inside a layer resolves against the consuming project.
  alias: { "#bantou-ui": currentDir },
  modules: ["@nuxt/ui", "unplugin-fonts/nuxt"],
  css: [join(currentDir, "assets/css/main.css")],
  // Cork (the app this UI is ported from) is dark-only; pin it (see packages/desktop history).
  colorMode: {
    preference: "dark",
    fallback: "dark",
  },
  // Cork font stack (`--font-sans` / `--font-display` in assets/css/main.css) via Fontsource.
  unfonts: {
    fontsource: {
      families: ["Inter Variable", "Space Grotesk Variable"],
    },
  },
});
