import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileSync } from "node:fs";
import { FakeCenter } from "../../center-client/test/helpers/fake-center";
import { AUD, PROXY_KEY, goodClaims, makeKey, sign, startJwks, TEAM } from "../test/server/utils/guard/helpers";

// The e2e stack: the built web backend (`.output`, all of it behind the guard) in front of a fake center, everything on
// 127.0.0.1. The browser gets the shared key and a signed Access JWT as request headers, standing in for Cloudflare.

const pkg = fileURLToPath(new URL("..", import.meta.url));

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer().listen(0, "127.0.0.1", () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => resolve(p));
    });
  });
}

export interface Stack {
  base: string;
  center: FakeCenter;
  /** Headers Cloudflare would add. */
  headers: Record<string, string>;
  /** Set the center's session list (names only). */
  setSessions(names: string[]): void;
  /** Point the backend at the fake center (default) or at nothing (settings file removed: "no target"). */
  setTarget(on: boolean): void;
  /** Push a `sessions` event from the center to the web backend. */
  pushSessionsEvent(reason: string, name: string): Promise<void>;
  close(): Promise<void>;
}

export async function startStack(): Promise<Stack> {
  const key = makeKey("e2e-kid");
  const jwks = await startJwks([key]);
  const center = await FakeCenter.start("e2e-center-token-0123456789");
  const dir = mkdtempSync(join(tmpdir(), "bantou-web-e2e-"));
  const settingsFile = join(dir, "settings.json");
  const settings = JSON.stringify({ enabled: false, port: 7910, workspace: "~/.bantou", token: "", remote: { url: center.url, token: "e2e-center-token-0123456789" } });
  writeFileSync(settingsFile, settings, { mode: 0o600 });
  const conns: ServerResponse[] = [];
  center.onGet = (req, res) => {
    if (req.url !== "/events") return false;
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(": hi\n\n");
    conns.push(res);
    return true;
  };
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const child: ChildProcess = spawn("node", [join(pkg, ".output/server/index.mjs")], {
    cwd: pkg,
    stdio: "pipe",
    env: {
      PATH: process.env.PATH ?? "",
      CF_TEAM: TEAM,
      CF_AUD: AUD,
      ALLOWED_EMAILS: "alice@example.test",
      PROXY_KEY,
      WEB_CF_CERTS_URL: jwks.url,
      WEB_SETTINGS_FILE: settingsFile,
      HOST: "127.0.0.1",
      PORT: String(port),
    },
  });
  let log = "";
  child.stdout?.on("data", (d) => (log += d));
  child.stderr?.on("data", (d) => (log += d));
  const headers = { "x-bantou-proxy-key": PROXY_KEY, "cf-access-jwt-assertion": sign(key, goodClaims({ exp: Math.floor(Date.now() / 1000) + 6 * 3600 })) };
  const close = async () => {
    child.kill("SIGTERM");
    for (const c of conns) c.end();
    await jwks.close();
    await center.close();
    rmSync(dir, { recursive: true, force: true });
  };
  for (let i = 0; ; i++) {
    try {
      await fetch(base + "/api/me");
      break;
    } catch {
      if (i > 100) {
        await close();
        throw new Error(`server が起動しない (.output は build 済みか): ${log}`);
      }
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  return {
    base,
    center,
    headers,
    setTarget: (on) => (on ? writeFileSync(settingsFile, settings, { mode: 0o600 }) : rmSync(settingsFile, { force: true })),
    setSessions: (names) => center.tools.set("session_list", names.map((name) => ({ name, state: "running" }))),
    pushSessionsEvent: async (reason, name) => {
      for (let i = 0; i < 100 && conns.length === 0; i++) await new Promise((r) => setTimeout(r, 50));
      for (const c of conns) c.write(`event: sessions\ndata: ${JSON.stringify({ reason, name })}\n\n`);
    },
    close,
  };
}
