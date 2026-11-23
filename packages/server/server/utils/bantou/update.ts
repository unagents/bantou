import { execFile } from "node:child_process";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { SERVER_VERSION_PATTERN } from "@agent-hand/bantou-protocol";
import { writePending } from "./pending";
import type { WorkQueue } from "./queue";

/** supervisor との取り決めのファイル名（bin/supervisor.mjs と同じ）。 */
export const UPDATE_FILE = "update.json";

/** 最新版の確認（npx）の打ち切り。 */
export const FETCH_TIMEOUT_MS = 300_000;
/** 待ちの間に「動いている worker が全部終わったか」を見る間隔。 */
export const POLL_MS = 1000;

/** update.json の中身。restart = 子を spec で入れ替える合図、failed = 直近の更新の失敗（supervisor が書く）。 */
export type UpdateFile =
  | { state: "restart"; to: string; spec: string }
  | { state: "failed"; to: string; error: string; at: string };

/** config の update.spec の {version} を置き換える。 */
export function buildSpec(template: string, version: string): string {
  return template.split("{version}").join(version);
}

/** x.y.z 同士の比較（a > b で正、等しいと 0）。 */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

export type FetchRunner = (cmd: string, args: string[], timeoutMs: number) => Promise<{ stdout: string }>;

const defaultRunner: FetchRunner = (cmd, args, timeoutMs) =>
  new Promise((resolve, reject) => {
    execFile(cmd, args, { encoding: "utf8", timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: 1 << 20 }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error((stderr || "").trim().split("\n").slice(-3).join(" ") || err.message));
        return;
      }
      resolve({ stdout });
    });
  });

/**
 * 取得元（config の update.spec、{version} を latest にする）の最新版を見る。`npx -y --package=<spec> -- bantou --version` の最終行。
 * x.y.z でなければ投げる。
 */
export async function fetchLatestVersion(template: string, run: FetchRunner = defaultRunner): Promise<string> {
  const spec = buildSpec(template, "latest");
  const { stdout } = await run("npx", ["-y", `--package=${spec}`, "--", "bantou", "--version"], FETCH_TIMEOUT_MS);
  const got = stdout.trim().split("\n").pop()?.trim() ?? "";
  if (!SERVER_VERSION_PATTERN.test(got)) throw new Error(`最新版の出力が x.y.z でない: ${got.slice(0, 40) || "(空)"}`);
  return got;
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(value) + "\n");
  await rename(tmp, path);
}

export async function readUpdateFile(workspace: string): Promise<UpdateFile | undefined> {
  try {
    const v = JSON.parse(await readFile(join(workspace, UPDATE_FILE), "utf8")) as Record<string, unknown>;
    if (v.state === "restart" && typeof v.to === "string" && typeof v.spec === "string") return { state: "restart", to: v.to, spec: v.spec };
    if (v.state === "failed" && typeof v.to === "string" && typeof v.error === "string" && typeof v.at === "string") {
      return { state: "failed", to: v.to, error: v.error, at: v.at };
    }
  } catch {
    // 無い・壊れている
  }
  return undefined;
}

export async function writeUpdateFile(workspace: string, f: UpdateFile): Promise<void> {
  await writeJsonAtomic(join(workspace, UPDATE_FILE), f);
}

export interface SelfUpdaterDeps {
  workspace: string;
  /** 動いている版（x.y.z。そうでなければ更新を確認しない）。 */
  serverVersion: string;
  /** config の update。 */
  update: { spec: string; checkIntervalMs: number; maxWaitMs: number };
  queue: Pick<WorkQueue, "pause" | "resume" | "counts" | "waiting" | "abortRunning">;
  /** 最新版を見る。既定は npx。 */
  fetchLatest?: (specTemplate: string) => Promise<string>;
  /** 入れ替えのための終了を頼む（plugin の shutdown）。 */
  requestExit: (reason: string) => void;
  log: (msg: string) => void;
  pollMs?: number;
  now?: () => number;
}

export interface SelfUpdater {
  /** 一定間隔の確認を始める（最初の確認は 1 間隔の後）。 */
  start(): void;
  /** 1 回確認する（テスト用に公開）。新しい版が在れば待ちに入る。待ちが終わって終了を頼むまで返らない。 */
  check(): Promise<void>;
  /** 終了処理の中で呼ぶ。入れ替えに入っていれば、その後に増えた待ちも含めて file に持ち直す。 */
  flush(): Promise<void>;
  /** 入れ替えに入っているか（待ち・再起動）。 */
  updating(): boolean;
  close(): void;
}

export function createSelfUpdater(deps: SelfUpdaterDeps): SelfUpdater {
  const { workspace, serverVersion, queue, log } = deps;
  const fetchLatest = deps.fetchLatest ?? ((t: string) => fetchLatestVersion(t));
  const now = deps.now ?? Date.now;
  const pollMs = deps.pollMs ?? POLL_MS;
  const { spec: template, checkIntervalMs, maxWaitMs } = deps.update;
  let timer: ReturnType<typeof setInterval> | undefined;
  let phase: "idle" | "checking" | "waiting" | "restarting" = "idle";
  /** supervisor が「起動できなかった」と記録した版（同じ版を繰り返し試さない）。 */
  let failedTo: string | undefined;
  let skipLogged: string | undefined;
  let closed = false;

  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

  /** 待ちに入った版 latest まで、動いている worker が終わるのを待つ（上限を越えたら残りを止める）。 */
  async function drain(latest: string): Promise<void> {
    queue.pause();
    const since = now();
    let lastRunning = -1;
    for (;;) {
      if (closed) {
        queue.resume();
        return;
      }
      const { running } = queue.counts();
      if (running === 0) return;
      if (now() - since >= maxWaitMs) {
        log(`待ちの上限（${Math.round(maxWaitMs / 60_000)} 分）を越えた、残りの worker ${running} を止めて進む: 版 ${latest}`);
        queue.abortRunning();
        return;
      }
      if (running !== lastRunning) {
        log(`待っている（worker ${running}）: 版 ${latest} へ入れ替えるため、新しい launch は取り出さない`);
        lastRunning = running;
      }
      await sleep(pollMs);
    }
  }

  async function check(): Promise<void> {
    if (phase !== "idle" || closed) return;
    phase = "checking";
    try {
      let latest: string;
      try {
        latest = await fetchLatest(template);
      } catch (e) {
        log(`最新版を確認できない: ${(e instanceof Error ? e.message : String(e)).slice(0, 200)}`);
        phase = "idle";
        return;
      }
      if (compareVersions(latest, serverVersion) <= 0) {
        phase = "idle";
        return;
      }
      if (failedTo === latest) {
        if (skipLogged !== latest) log(`版 ${latest} は前回起動できなかったので見送る（動いている版 ${serverVersion}）`);
        skipLogged = latest;
        phase = "idle";
        return;
      }
      log(`版 ${latest} を見つけた（動いている版 ${serverVersion}）`);
      phase = "waiting";
      await drain(latest);
      if (closed) {
        phase = "idle";
        return;
      }
      log(`入れ替える: ${serverVersion} -> ${latest}`);
      phase = "restarting";
      try {
        const n = await writePending(workspace, queue.waiting());
        log(`queue の待ち ${n} 件を file に持った`);
        await writeUpdateFile(workspace, { state: "restart", to: latest, spec: buildSpec(template, latest) });
      } catch (e) {
        log(`入れ替えを取りやめる（file を書けない）: ${(e instanceof Error ? e.message : String(e)).slice(0, 200)}`);
        phase = "idle";
        queue.resume();
        return;
      }
      deps.requestExit("update");
    } catch (e) {
      log(`更新の確認で例外: ${e instanceof Error ? e.message : String(e)}`);
      if (phase === "waiting") queue.resume();
      if (phase !== "restarting") phase = "idle";
    }
  }

  return {
    start() {
      if (timer !== undefined || closed) return;
      void readUpdateFile(workspace).then((f) => {
        if (f?.state === "failed") failedTo = f.to;
      });
      timer = setInterval(() => void check(), checkIntervalMs);
      timer.unref?.();
    },
    check,
    async flush() {
      if (phase !== "restarting") return;
      try {
        await writePending(workspace, queue.waiting());
      } catch (e) {
        log(`queue の待ちを file に持てない: ${(e instanceof Error ? e.message : String(e)).slice(0, 200)}`);
      }
    },
    updating: () => phase === "waiting" || phase === "restarting",
    close() {
      closed = true;
      if (timer !== undefined) clearInterval(timer);
      timer = undefined;
    },
  };
}
