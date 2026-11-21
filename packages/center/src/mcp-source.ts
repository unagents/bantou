/**
 * 追加の MCP の接続（mcpServers）の「今の値」を設定 file から読む（同期。mtime / size / inode が変わった時だけ読み直す）。
 *
 * mcpServers は center の側だけの項目で、運用者が center-settings.json（共通）と sessions.json（session ごと）を直接書く。
 * center は書かれた物を呼び出しの度に見る（割り当てを外すと、開いている古い MCP session からの呼び出しも次の呼び出しから断られる）。
 * file が壊れていて読めない時は undefined（呼ぶ側は割り当て無しとして扱う = fail closed）。file が無ければ空。
 * 値は log に出さない（理由の種類だけ）。
 */
import { readFileSync, statSync } from "node:fs";

export interface McpSource {
  /** center 共通の設定の mcpServers（無ければ undefined）。 */
  common: unknown;
  /** session 名 → その session の設定の mcpServers。 */
  sessions: Map<string, unknown>;
}

type Read<T> = { ok: true; value: T } | { ok: false };

const isRec = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function readCached<T>(path: string, parse: (raw: unknown) => T, empty: T, log: (m: string) => void): () => Read<T> {
  let cache: { key: string; value: Read<T> } | undefined;
  return () => {
    let key: string;
    try {
      const st = statSync(path);
      key = `${st.mtimeMs}:${st.size}:${st.ino}`;
    } catch {
      cache = undefined;
      return { ok: true, value: empty };
    }
    if (cache?.key === key) return cache.value;
    let value: Read<T>;
    try {
      value = { ok: true, value: parse(JSON.parse(readFileSync(path, "utf8"))) };
    } catch (e) {
      value = { ok: false };
      log(`設定 file を読めない（追加の MCP の接続は割り当て無しとして扱う）: ${path} ${e instanceof Error ? e.name : "error"}`);
    }
    cache = { key, value };
    return value;
  };
}

/** center-settings.json と sessions.json から mcpServers を読む関数を作る。どちらかが読めなければ undefined。 */
export function createMcpSource(centerSettingsPath: string, sessionsPath: string, log: (m: string) => void = () => {}): () => McpSource | undefined {
  const common = readCached<unknown>(
    centerSettingsPath,
    (raw) => {
      if (!isRec(raw)) throw new Error("not object");
      return raw.mcpServers;
    },
    undefined,
    log,
  );
  const sessions = readCached<Map<string, unknown>>(
    sessionsPath,
    (raw) => {
      if (!Array.isArray(raw)) throw new Error("not array");
      const m = new Map<string, unknown>();
      for (const r of raw) if (isRec(r) && typeof r.name === "string" && isRec(r.settings) && r.settings.mcpServers !== undefined) m.set(r.name, r.settings.mcpServers);
      return m;
    },
    new Map(),
    log,
  );
  return () => {
    const c = common();
    const s = sessions();
    return c.ok && s.ok ? { common: c.value, sessions: s.value } : undefined;
  };
}
