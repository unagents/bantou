import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { assertNamePrefix } from "./config";

/** key の元に付ける固定の文字列（名前の規約の版）。 */
export const NAME_KEY_SALT = "bantou-name/v1:";

/** key の桁数（sha256 の hex の先頭）。 */
export const NAME_KEY_LENGTH = 10;

const MACHINE_ID_FILES = ["/etc/machine-id", "/var/lib/dbus/machine-id"] as const;

/** 機械の ID を読む。macOS は IOPlatformUUID、Linux は /etc/machine-id（無ければ /var/lib/dbus/machine-id）。読めなければ投げる。 */
export function readMachineId(platform: NodeJS.Platform = process.platform): string {
  if (platform === "darwin") {
    let out: string;
    try {
      out = execFileSync("ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"], { encoding: "utf8", timeout: 10_000 });
    } catch (e) {
      throw new Error(`機械の ID を読めない（ioreg）: ${e instanceof Error ? e.message : String(e)}`);
    }
    const m = /"IOPlatformUUID"\s*=\s*"([^"]+)"/.exec(out);
    if (!m || (m[1] as string).trim() === "") throw new Error("機械の ID を読めない（ioreg に IOPlatformUUID が無い）");
    return m[1] as string;
  }
  const errors: string[] = [];
  for (const f of MACHINE_ID_FILES) {
    try {
      const v = readFileSync(f, "utf8");
      if (v.trim() !== "") return v;
      errors.push(`${f}: 空`);
    } catch (e) {
      errors.push(`${f}: ${(e as Error).message}`);
    }
  }
  throw new Error(`機械の ID を読めない（${errors.join(" / ")}）`);
}

/** key = sha256("bantou-name/v1:" + 機械の ID を小文字にして前後の空白を除いた物) の hex の先頭 10 桁。 */
export function nameKey(machineId: string): string {
  const norm = machineId.trim().toLowerCase();
  if (norm === "") throw new Error("機械の ID が空");
  return createHash("sha256").update(NAME_KEY_SALT + norm).digest("hex").slice(0, NAME_KEY_LENGTH);
}

/** name = [<prefix>-]bantou-server-<key>。prefix は英小文字・数字 1〜16 文字。 */
export function buildServerName(machineId: string, prefix?: string): string {
  const base = `bantou-server-${nameKey(machineId)}`;
  if (prefix === undefined) return base;
  return `${assertNamePrefix(prefix, "name prefix")}-${base}`;
}
