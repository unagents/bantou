import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

/** 名前の key の hash の前置き（protocol v2 の名前の規約。center と server で同じ式を使う）。 */
export const NAME_HASH_PREFIX = "bantou-name/v1:";

/** center の agent-messenger 上の名前の前置き。名前 = `bantou-center-<key>`。 */
export const CENTER_NAME_PREFIX = "bantou-center-";

/** 機械の ID の読み方（テストで差し替える）。 */
export interface MachineIdSource {
  platform: NodeJS.Platform;
  /** macOS: `ioreg -rd1 -c IOPlatformExpertDevice` の出力。 */
  ioreg: () => string;
  /** Linux: file の中身。読めなければ投げる。 */
  readFile: (path: string) => string;
}

const realSource: MachineIdSource = {
  platform: process.platform,
  ioreg: () => execFileSync("ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"], { encoding: "utf8", timeout: 10_000 }),
  readFile: (path) => readFileSync(path, "utf8"),
};

/** 機械の ID（macOS: IOPlatformUUID、Linux: /etc/machine-id、無ければ /var/lib/dbus/machine-id）。読めなければ投げる。 */
export function readMachineId(src: MachineIdSource = realSource): string {
  if (src.platform === "darwin") {
    let out: string;
    try {
      out = src.ioreg();
    } catch (e) {
      throw new Error(`機械の ID を読めない（ioreg）: ${e instanceof Error ? e.message : String(e)}`);
    }
    const m = /"IOPlatformUUID"\s*=\s*"([^"]+)"/.exec(out);
    if (!m?.[1]?.trim()) throw new Error("機械の ID を読めない（ioreg に IOPlatformUUID が無い）");
    return m[1];
  }
  const errors: string[] = [];
  for (const path of ["/etc/machine-id", "/var/lib/dbus/machine-id"]) {
    try {
      const id = src.readFile(path).trim();
      if (id) return id;
      errors.push(`${path}: 空`);
    } catch (e) {
      errors.push(`${path}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  throw new Error(`機械の ID を読めない（${errors.join(" / ")}）`);
}

/** key = sha256("bantou-name/v1:" + 機械の ID を小文字にして前後の空白を除いた物) の hex の先頭 10 桁。 */
export function nameKey(machineId: string): string {
  return createHash("sha256").update(`${NAME_HASH_PREFIX}${machineId.toLowerCase().trim()}`).digest("hex").slice(0, 10);
}

/** center の名前 `bantou-center-<key>`。機械の ID が読めなければ投げる（起動しない）。 */
export function centerName(src?: MachineIdSource): string {
  return `${CENTER_NAME_PREFIX}${nameKey(readMachineId(src))}`;
}
