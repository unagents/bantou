import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

export interface LiveProcess {
  pid: number;
  argv: string;
}

/** `ps -ww -e -o pid=,args=` の出力を解釈する。 */
export function parsePsOutput(out: string): LiveProcess[] {
  const procs: LiveProcess[] = [];
  for (const line of out.split("\n")) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (m) procs.push({ pid: Number(m[1]), argv: m[2] });
  }
  return procs;
}

/** 走っているプロセス一覧。取れなければ null。 */
export async function listLiveProcesses(): Promise<LiveProcess[] | null> {
  try {
    const { stdout } = await run("ps", ["-ww", "-e", "-o", "pid=,args="], {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    });
    return parsePsOutput(stdout);
  } catch {
    return null;
  }
}

/**
 * argv が、その session id の claude -p 実行を指しているか。
 * prompt は ` -- ` の後ろに来るので、その手前だけを見る。id は語境界で一致させる。
 */
export function matchesSession(argv: string, sessionId: string): boolean {
  const cut = argv.indexOf(" -- ");
  const head = cut === -1 ? argv : argv.slice(0, cut);
  const tokens = head.split(/\s+/);
  if (!tokens.includes("-p") && !tokens.includes("--print")) return false;
  for (let i = 0; i < tokens.length - 1; i++) {
    if ((tokens[i] === "--session-id" || tokens[i] === "--resume") && tokens[i + 1] === sessionId) {
      return true;
    }
  }
  return false;
}
