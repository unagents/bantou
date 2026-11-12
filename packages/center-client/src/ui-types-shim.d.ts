// `packages/ui/types/index.ts` names `import("~/tauri").Update` (a Nuxt alias used by the updater state).
// center-client only needs the settings types, so the alias is stubbed for its typecheck.
declare module "~/tauri" {
  export type Update = unknown;
}
