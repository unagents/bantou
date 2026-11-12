import { getWorkspaceDirectory, pickDirectory, setWorkspaceDirectory } from "~/api";

/** Current workspace directory for this window (null = welcome screen). */
export function useWorkspace() {
  const dir = useState<string | null>("workspace-dir", () => null);
  const loaded = useState<boolean>("workspace-loaded", () => false);

  async function load() {
    dir.value = await getWorkspaceDirectory();
    loaded.value = true;
  }

  async function open(path: string) {
    await setWorkspaceDirectory(path);
    dir.value = path;
  }

  /** Native folder picker → open. Resolves to false when cancelled. */
  async function pickAndOpen(): Promise<boolean> {
    const picked = await pickDirectory();
    if (!picked) return false;
    await open(picked);
    return true;
  }

  return { dir, loaded, load, open, pickAndOpen };
}
