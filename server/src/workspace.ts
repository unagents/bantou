import { mkdir } from "node:fs/promises";
import { join } from "node:path";

/** `<workspace>/` と `<workspace>/repos/` を無ければ作る。repos のパスを返す。 */
export async function prepareWorkspace(workspace: string): Promise<string> {
  const repos = join(workspace, "repos");
  await mkdir(repos, { recursive: true });
  return repos;
}
