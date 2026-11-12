// output route: the `event: status` frame goes through the redactor even when the text comes from a source that did
// not scrub it (a second line of defence; center-client's own scrub is bypassed here by a fake `terminal`).

import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import { createApp, createRouter, toNodeListener } from "h3";
import { createRedactor, type CenterClient } from "bantou-center-client";
import { createOutputHandler } from "../../../../server/utils/terminal/handlers";

const TOKEN = "Tok/Secret+AbC123 xyz";
const forms: Record<string, string> = {
  exact: TOKEN,
  lower: TOKEN.toLowerCase(),
  upper: TOKEN.toUpperCase(),
  urlEncoded: encodeURIComponent(TOKEN),
  base64: Buffer.from(TOKEN).toString("base64").replace(/=+$/, ""),
};

describe("output route: status frame is redacted", () => {
  let server: Server;
  let base = "";
  before(async () => {
    const redactor = createRedactor({ selectTarget: async () => ({ url: "http://127.0.0.1:1/mcp", token: TOKEN, source: "remote" }) });
    const client = {
      redactor,
      terminal: {
        openOutput(session: string, o: { onStatus?: (s: unknown) => void }) {
          // a status whose message carries the token in several spellings, as an unscrubbed source would
          queueMicrotask(() => o.onStatus?.({ session, state: "rejected", message: `bad ${Object.values(forms).join(" | ")}` }));
          return { stop() {} };
        },
      },
    } as unknown as CenterClient;
    const app = createApp();
    const router = createRouter();
    router.get("/api/sessions/:name/output", createOutputHandler(() => client));
    app.use(router);
    server = createServer(toNodeListener(app));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(async () => {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  });

  it("token in any spelling (case, URL-encoded, base64) does not reach the browser", async () => {
    const res = await fetch(base + "/api/sessions/live/output");
    const text = await res.text();
    assert.match(text, /event: status/);
    assert.match(text, /\*\*\*/);
    for (const [name, f] of Object.entries(forms)) assert.ok(!text.includes(f), `${name} form in the status frame`);
  });
});
