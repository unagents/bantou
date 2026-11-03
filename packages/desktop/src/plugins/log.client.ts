import { errorText, logWebview } from "~/api/log";

// Failures nobody catches: they would only reach the devtools console, which is gone after a restart.
export default defineNuxtPlugin((nuxtApp) => {
  window.addEventListener("error", (ev) => {
    logWebview("error", `uncaught error: ${ev.message} (${ev.filename}:${ev.lineno})`);
  });
  window.addEventListener("unhandledrejection", (ev) => {
    logWebview("error", `unhandled rejection: ${errorText(ev.reason)}`);
  });
  nuxtApp.hook("vue:error", (err, _instance, info) => {
    logWebview("error", `vue error (${info}): ${errorText(err)}`);
  });
});
