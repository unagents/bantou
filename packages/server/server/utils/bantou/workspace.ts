import { mkdir } from "node:fs/promises";
import { join } from "node:path";

/** `<workspace>/caps` と `<workspace>/workers` を無ければ作る。 */
export async function prepareWorkspace(
  workspace: string,
): Promise<{ caps: string; workers: string }> {
  const caps = join(workspace, "caps");
  const workers = join(workspace, "workers");
  await mkdir(caps, { recursive: true });
  await mkdir(workers, { recursive: true });
  return { caps, workers };
}
