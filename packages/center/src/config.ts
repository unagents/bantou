import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { z } from "zod";

/** `claude --permission-mode` の選択肢。 */
export const PERMISSION_MODES = [
  "acceptEdits",
  "auto",
  "bypassPermissions",
  "default",
  "dontAsk",
  "plan",
] as const;

export const SPAWN_MODES = ["same-dir", "worktree", "session"] as const;

export const DEFAULT_REMOTE_CONTROL = {
  continueOnRestart: true,
  autoConsent: true,
  restartDelayMs: 5000,
  maxRestarts: 5,
  stopGraceMs: 5000,
} as const;

export const DEFAULT_PROJECT = {
  spawn: "same-dir",
  permissionMode: "auto",
  autostart: false,
} as const;

/** server からの返信待ちの既定（35 分。server 側 session.timeoutMs の既定 30 分 + 余裕）。 */
export const DEFAULT_SERVER_TIMEOUT_MS = 2_100_000;

const NAME = /^[A-Za-z0-9_-]+$/;

const absPath = z.string().min(1).refine((p) => isAbsolute(p), { message: "絶対パスで指定する" });

const projectSchema = z.object({
  name: z.string().regex(NAME, "英数字と _ - のみ"),
  path: absPath,
  spawn: z.enum(SPAWN_MODES).default(DEFAULT_PROJECT.spawn),
  permissionMode: z.enum(PERMISSION_MODES).default(DEFAULT_PROJECT.permissionMode),
  capacity: z.number().int().min(1).optional(),
  autostart: z.boolean().default(DEFAULT_PROJECT.autostart),
  env: z.record(z.string(), z.string()).optional(),
});

const remoteControlSchema = z.object({
  /** 未指定なら起動時に解決する（claude-path.ts）。 */
  claude: z.string().min(1).optional(),
  continueOnRestart: z.boolean().default(DEFAULT_REMOTE_CONTROL.continueOnRestart),
  autoConsent: z.boolean().default(DEFAULT_REMOTE_CONTROL.autoConsent),
  restartDelayMs: z.number().int().min(0).default(DEFAULT_REMOTE_CONTROL.restartDelayMs),
  maxRestarts: z.number().int().min(0).default(DEFAULT_REMOTE_CONTROL.maxRestarts),
  stopGraceMs: z.number().int().min(0).default(DEFAULT_REMOTE_CONTROL.stopGraceMs),
  env: z.record(z.string(), z.string()).optional(),
});

const serverSchema = z.object({
  name: z.string().regex(NAME, "英数字と _ - のみ"),
  broker: z
    .string()
    .refine((u) => {
      try {
        return new URL(u).protocol === "http:";
      } catch {
        return false;
      }
    }, { message: "http の URL で指定する（messenger-client は https 非対応）" })
    // 末尾 / を除く（/health が //health にならないように）
    .transform((u) => u.replace(/\/+$/, "")),
  token: z.string().optional(),
  timeoutMs: z.number().int().positive().default(DEFAULT_SERVER_TIMEOUT_MS),
});

export const configSchema = z
  .object({
    projects: z.array(projectSchema).default([]),
    remoteControl: remoteControlSchema.default(() => remoteControlSchema.parse({})),
    servers: z.array(serverSchema).default([]),
    logDir: absPath.optional(),
  })
  .superRefine((cfg, ctx) => {
    for (const key of ["projects", "servers"] as const) {
      const seen = new Set<string>();
      cfg[key].forEach((item, i) => {
        if (seen.has(item.name)) {
          ctx.addIssue({ code: "custom", path: [key, i, "name"], message: `名前が重複: ${item.name}` });
        }
        seen.add(item.name);
      });
    }
  });

export type ProjectConfig = z.infer<typeof projectSchema>;
export type RemoteControlConfig = z.infer<typeof remoteControlSchema>;
export type ServerConfig = z.infer<typeof serverSchema>;

export interface Config {
  projects: ProjectConfig[];
  remoteControl: RemoteControlConfig;
  servers: ServerConfig[];
  /** remote-control の出力ログ置き場（絶対パス）。 */
  logDir: string;
}

/** zod の検証結果から Config を作る（logDir の既定は config と同じ場所の center-logs）。 */
export function parseConfig(data: unknown, configPath: string): Config {
  const r = configSchema.safeParse(data ?? {});
  if (!r.success) {
    const issues = r.error.issues
      .map((i) => `${i.path.length ? i.path.join(".") : "(root)"}: ${i.message}`)
      .join("; ");
    throw new Error(`config が不正: ${issues}`);
  }
  const { logDir, ...rest } = r.data;
  return { ...rest, logDir: logDir ?? join(dirname(resolve(configPath)), "center-logs") };
}

/** config.json を読み込んで検証する。 */
export async function loadConfig(path: string): Promise<Config> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (e) {
    throw new Error(`config を読めない: ${path} (${(e as Error).message})`);
  }
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    throw new Error(`config が JSON として不正: ${path} (${(e as Error).message})`);
  }
  return parseConfig(data, path);
}
