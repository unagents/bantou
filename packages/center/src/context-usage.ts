import { homedir } from "node:os";
import { join } from "node:path";
import { open, readdir, stat } from "node:fs/promises";
import type { Logger } from "./log.js";

/** session の claude のコンテキスト使用状況（desktop に見せる）。 */
export interface ContextUsage {
  /** 最後の assistant message の usage（input + cache_creation + cache_read + output）の合計。 */
  usedTokens: number;
  /** コンテキスト窓の大きさ。モデルから決められない時は null。 */
  windowTokens: number | null;
  /** usedTokens / windowTokens の % （小数 1 桁）。windowTokens が null なら null。 */
  percent: number | null;
  /** 値を取った時刻（ISO）。transcript 方式は最後の assistant message の時刻（無ければ読んだ時刻）、statusLine 方式は最後に値が変わった時刻。 */
  updatedAt: string;
  /** statusLine 方式の時だけ付く、claude が報告したモデル id（`model.id`）。 */
  model?: string;
}

/** `[1m]` 付きのモデルの窓。 */
export const WINDOW_1M = 1_000_000;

/**
 * モデル名から窓の大きさを決める。`[1m]` 付き（大文字小文字不問）が 1 つでもあれば 1,000,000。
 * それ以外は分からないので null（transcript の model は `[1m]` が落ちた素の名前で、使用量が 20 万を超える例もあり、素の名前から窓は決められない）。
 */
export function contextWindowFor(...models: Array<string | undefined>): number | null {
  return models.some((m) => m !== undefined && /\[1m\]/i.test(m)) ? WINDOW_1M : null;
}

export function makeUsage(usedTokens: number, windowTokens: number | null, updatedAt: string): ContextUsage {
  const percent = windowTokens ? Math.round((usedTokens / windowTokens) * 1000) / 10 : null;
  return { usedTokens, windowTokens, percent, updatedAt };
}

/** statusLine の stdin JSON（`context_window`）から読んだ値。 */
export interface StatusLineContext {
  windowTokens: number | null;
  /** used_percentage が null の間（初回の API 応答前・/compact 直後）は null。 */
  usedTokens: number | null;
  percent: number | null;
  model: string | undefined;
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/**
 * statusLine の stdin JSON を読む。context_window が無い・窓も使用量も読めない時は null。
 * 使用量は claude 自身の式（input + cache_creation + cache_read。output は含まない）= total_input_tokens、窓は context_window_size。
 * used_percentage は整数に丸められて来るので、窓があれば usedTokens / windowTokens から小数 1 桁で出し直す。
 */
export function parseStatusLine(payload: unknown): StatusLineContext | null {
  if (typeof payload !== "object" || payload === null) return null;
  const p = payload as { context_window?: unknown; model?: { id?: unknown } };
  const cw = p.context_window;
  if (typeof cw !== "object" || cw === null) return null;
  const c = cw as Record<string, unknown>;
  const size = num(c.context_window_size);
  const windowTokens = size !== null && size > 0 ? size : null;
  const pct = num(c.used_percentage);
  const input = num(c.total_input_tokens);
  const usedTokens = pct !== null && input !== null ? input : null;
  if (windowTokens === null && usedTokens === null) return null;
  const percent = usedTokens === null ? null : windowTokens ? Math.round((usedTokens / windowTokens) * 1000) / 10 : pct;
  return { windowTokens, usedTokens, percent, model: typeof p.model?.id === "string" ? p.model.id : undefined };
}

/** claude の設定 dir（env CLAUDE_CONFIG_DIR、無ければ ~/.claude）。 */
export function claudeConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
}

/** cwd に対応する transcript の dir 名（英数字以外を - にする。claude の規則）。 */
export function projectDirName(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, "-");
}

export interface LastUsage {
  tokens: number;
  model: string | undefined;
  at: string | undefined;
}

/** transcript の 1 行が assistant message ならその usage の合計。該当しない行は null。 */
export function parseAssistantUsage(line: string): LastUsage | null {
  if (!line.includes('"usage"')) return null;
  let o: unknown;
  try {
    o = JSON.parse(line);
  } catch {
    return null; // 書き込み途中の行など
  }
  if (typeof o !== "object" || o === null) return null;
  const r = o as { type?: unknown; isSidechain?: unknown; timestamp?: unknown; message?: { model?: unknown; usage?: Record<string, unknown> } };
  if (r.type !== "assistant" || r.isSidechain === true) return null;
  const u = r.message?.usage;
  const model = typeof r.message?.model === "string" ? r.message.model : undefined;
  if (!u || model === "<synthetic>") return null;
  const n = (k: string): number => (typeof u[k] === "number" && Number.isFinite(u[k]) ? (u[k] as number) : 0);
  const tokens = n("input_tokens") + n("cache_creation_input_tokens") + n("cache_read_input_tokens") + n("output_tokens");
  return { tokens, model, at: typeof r.timestamp === "string" ? r.timestamp : undefined };
}

/** transcript 末尾の最初の読み取り量と上限（該当行が見つからなければ 4 倍ずつ広げる）。 */
export const TAIL_START_BYTES = 64 * 1024;
export const TAIL_MAX_BYTES = 8 * 1024 * 1024;

/** transcript の末尾だけ読み、最後の assistant message の usage を返す。見つからなければ null。全体は読まない。 */
export async function readLastUsage(file: string): Promise<LastUsage | null> {
  const fh = await open(file, "r");
  try {
    const size = (await fh.stat()).size;
    for (let want = TAIL_START_BYTES; ; want *= 4) {
      const len = Math.min(size, want);
      const buf = Buffer.alloc(len);
      await fh.read(buf, 0, len, size - len);
      const lines = buf.toString("utf8").split("\n");
      if (len < size) lines.shift(); // 先頭は途中で切れている
      for (let i = lines.length - 1; i >= 0; i--) {
        const r = parseAssistantUsage(lines[i] ?? "");
        if (r) return r;
      }
      if (len >= size || want >= TAIL_MAX_BYTES) return null;
    }
  } finally {
    await fh.close();
  }
}

export interface TranscriptFile {
  file: string;
  mtimeMs: number;
  size: number;
}

/** dir の *.jsonl のうち、mtime が sinceMs 以降で最も新しいもの。無ければ null。 */
export async function findNewestTranscript(dir: string, sinceMs: number): Promise<TranscriptFile | null> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return null;
  }
  let best: TranscriptFile | null = null;
  for (const n of names) {
    if (!n.endsWith(".jsonl")) continue;
    const file = join(dir, n);
    try {
      const st = await stat(file);
      if (st.mtimeMs >= sinceMs && (!best || st.mtimeMs > best.mtimeMs)) best = { file, mtimeMs: st.mtimeMs, size: st.size };
    } catch {
      // 消えた
    }
  }
  return best;
}

/** 追跡する session。 */
export interface UsageTarget {
  name: string;
  /** claude の cwd。 */
  path: string;
  /** 今回の起動の時刻（ISO）。これより古い transcript は別の起動のものとして見ない。 */
  startedAt: string | null;
  /** 起動中か（stopped / error は更新しない。直前の値は残す）。 */
  running: boolean;
}

export interface ContextUsageTracker {
  /** statusLine の値があればそれ、無ければ transcript 方式の値（窓が分からなければ statusLine の窓で補う）。 */
  get(name: string): ContextUsage | null;
  /**
   * claude の statusLine が渡した JSON を反映する。startedAt はその session の今回の起動時刻（起動し直したら捨てるため）。
   * 読めない JSON は false。値が変わった時だけ onChange を呼ぶ。
   */
  applyStatusLine(name: string, payload: unknown, startedAt: string | null): boolean;
  /** 全 target を 1 回見る。変化があった session ごとに onChange を呼ぶ。 */
  poll(): Promise<void>;
  start(): void;
  stop(): void;
}

/** 起動時刻より少し前の mtime も許す（時計の粒度）。 */
const SINCE_SLACK_MS = 2000;

/**
 * session ごとの使用状況を一定間隔で見る。
 * - transcript は <configDir>/projects/<cwd を変換した dir>/ の中で、今回の起動以降に更新された最新の *.jsonl。
 * - mtime と size が前回と同じなら読まない。読む時も末尾だけ。
 * - 値が変わった時だけ onChange を呼ぶ（間引きは間隔そのもの）。
 */
export function createContextUsageTracker(opts: {
  targets: () => UsageTarget[];
  onChange: (name: string) => void;
  /** center の model 設定（`[1m]` 付きなら窓を 1M にする）。 */
  model?: string;
  /** claude の設定 dir。省略時は env CLAUDE_CONFIG_DIR、無ければ ~/.claude。 */
  configDir?: string;
  intervalMs?: number;
  log?: Logger;
}): ContextUsageTracker {
  const configDir = opts.configDir ?? claudeConfigDir();
  const intervalMs = opts.intervalMs ?? 5000;
  interface Seen {
    startedAt: string | null;
    file: string;
    mtimeMs: number;
    size: number;
    usage: ContextUsage | null;
  }
  const seen = new Map<string, Seen>();
  interface StatusSeen {
    startedAt: string | null;
    windowTokens: number | null;
    usage: ContextUsage | null;
  }
  const status = new Map<string, StatusSeen>();
  let timer: NodeJS.Timeout | null = null;
  let polling = false;

  const same = (a: ContextUsage | null, b: ContextUsage | null): boolean =>
    a === b || (!!a && !!b && a.usedTokens === b.usedTokens && a.windowTokens === b.windowTokens && a.updatedAt === b.updatedAt);

  const one = async (t: UsageTarget): Promise<void> => {
    // 起動し直したら statusLine 由来の値も捨てる
    const st = status.get(t.name);
    if (st && st.startedAt !== t.startedAt) {
      status.delete(t.name);
      if (st.usage) opts.onChange(t.name);
    }
    const prev = seen.get(t.name);
    // 起動し直したら前の値は捨てる（古い起動の値を見せない）
    const restarted = prev !== undefined && prev.startedAt !== t.startedAt;
    if (restarted) {
      seen.delete(t.name);
      if (prev.usage) opts.onChange(t.name);
    }
    if (!t.running || !t.startedAt) return;
    const since = Date.parse(t.startedAt) - SINCE_SLACK_MS;
    const found = await findNewestTranscript(join(configDir, "projects", projectDirName(t.path)), Number.isNaN(since) ? 0 : since);
    if (!found) return;
    const cur = restarted ? undefined : prev;
    if (cur && cur.file === found.file && cur.mtimeMs === found.mtimeMs && cur.size === found.size) return;
    const last = await readLastUsage(found.file);
    const usage = last ? makeUsage(last.tokens, contextWindowFor(opts.model, last.model), last.at ?? new Date().toISOString()) : null;
    seen.set(t.name, { startedAt: t.startedAt, file: found.file, mtimeMs: found.mtimeMs, size: found.size, usage: usage ?? cur?.usage ?? null });
    if (usage && !same(cur?.usage ?? null, usage)) opts.onChange(t.name);
  };

  const poll = async (): Promise<void> => {
    if (polling) return;
    polling = true;
    try {
      const targets = opts.targets();
      const names = new Set(targets.map((t) => t.name));
      for (const n of [...seen.keys()]) if (!names.has(n)) seen.delete(n); // 消えた session
      for (const n of [...status.keys()]) if (!names.has(n)) status.delete(n);
      for (const t of targets) {
        try {
          await one(t);
        } catch (e) {
          opts.log?.(`context 使用量の取得失敗: ${t.name} ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    } finally {
      polling = false;
    }
  };

  const get = (name: string): ContextUsage | null => {
    const st = status.get(name);
    if (st?.usage) return st.usage;
    const tr = seen.get(name)?.usage ?? null;
    // transcript の窓が分からない時だけ statusLine の窓で補う
    if (tr && tr.windowTokens === null && st?.windowTokens) return makeUsage(tr.usedTokens, st.windowTokens, tr.updatedAt);
    return tr;
  };

  const applyStatusLine = (name: string, payload: unknown, startedAt: string | null): boolean => {
    const p = parseStatusLine(payload);
    if (!p) return false;
    const prev = status.get(name);
    const old = prev && prev.startedAt === startedAt ? prev : undefined;
    const before = get(name);
    const usage: ContextUsage | null =
      p.usedTokens === null
        ? null
        : {
            ...makeUsage(p.usedTokens, p.windowTokens, new Date().toISOString()),
            ...(p.model ? { model: p.model } : {}),
          };
    // used_percentage が null の間（初回の API 応答前・/compact 直後）は使用量を持たず、窓だけ覚えて tokens は transcript に任せる
    status.set(name, { startedAt, windowTokens: p.windowTokens ?? old?.windowTokens ?? null, usage });
    const after = get(name);
    const same =
      before === after ||
      (!!before && !!after && before.usedTokens === after.usedTokens && before.windowTokens === after.windowTokens && before.percent === after.percent && before.model === after.model);
    if (!same) opts.onChange(name);
    return true;
  };

  return {
    get,
    applyStatusLine,
    poll,
    start() {
      if (timer) return;
      timer = setInterval(() => void poll(), intervalMs);
      timer.unref();
      void poll();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}
