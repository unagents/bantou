// Nuxt UI theme tokens (`ui.colors.*` picks a Tailwind palette name per
// semantic color, merged into @nuxt/ui's default config — see
// node_modules/@nuxt/ui/dist/module.mjs `getDefaultConfig`). `neutral` and
// `primary` are tuned to match Cork's dark palette
// (`--color-cork-bg`/`--color-cork-accent` in app/assets/css/main.css):
// slate for neutrals, indigo for the accent.
export default defineAppConfig({
  ui: {
    colors: {
      neutral: "slate",
      primary: "indigo",
    },
  },
});
