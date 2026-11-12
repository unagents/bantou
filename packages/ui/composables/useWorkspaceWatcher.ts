import { onBeforeUnmount, watch, type Ref } from "vue";
import { getPlatform, type UnlistenFn } from "~/tauri";

/**
 * Re-run `onMdChange` whenever a `.md` file directly under `dir` changes
 * (external editor, git checkout, ...). Non-recursive, debounced 300ms.
 * Ported from Cork's `useWorkspaceWatcher`.
 */
export function useWorkspaceWatcher(dir: Ref<string | null>, onMdChange: () => void) {
  let unwatch: UnlistenFn | null = null;

  async function attach(path: string) {
    detach();
    unwatch = await getPlatform().watchDir(
      path,
      (paths) => {
        if (paths.some((p) => p.endsWith(".md"))) onMdChange();
      },
      300,
    );
  }

  function detach() {
    if (unwatch) {
      unwatch();
      unwatch = null;
    }
  }

  watch(
    dir,
    (next) => {
      if (next) void attach(next);
      else detach();
    },
    { immediate: true },
  );

  onBeforeUnmount(detach);
}
