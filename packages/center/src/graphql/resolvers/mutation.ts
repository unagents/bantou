import { GraphQLError } from "graphql";
import { z } from "zod";
import { ATTACHMENT_TYPES, AttachmentError, MAX_ATTACHMENT_BYTES, matchesMagic, mediaType, saveAttachment } from "../../attachments.js";
import { LOGIN_CODE } from "../../login.js";
import { centerSettingsPatchSchema, projectSettingsPatchSchema } from "../../project-settings.js";
import { workerReplySchema } from "../../remotes.js";
import { retireServer } from "../../retire.js";
import { SESSION_NAME } from "../../sessions.js";
import type { GraphqlContext } from "../context.js";

/**
 * Mutation の resolver（schema-mutation.ts の field と 1 対 1。設計書 2.3 / 3 節）。
 * center の service（SessionManager・RemoteControlSupervisor・LoginFlow・Core・ServerLink・RemoteManager）を context 経由で
 * MCP の道具・HTTP route と同じ関数で呼ぶ。入力の検査も同じ zod の定義を使う。
 * 決定 6: 呼び出し元で client を分けない。MCP の道具が起動元以外に課していた `assertCenterOnly`（launcher 鍵）は掛けない。
 */
type Resolver = (parent: unknown, args: Record<string, unknown>, ctx: GraphqlContext) => unknown;

const sessionName = z.string().regex(SESSION_NAME, "英数字と _ - のみ");
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
/** 空でなく、4 文字ずつで、padding は末尾だけの base64（terminalInput。空の入力・長さの不正は通さない）。 */
const BASE64_STRICT = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/** 入力の誤り（client が直せる）。extensions.code = BAD_USER_INPUT。 */
function badInput(message: string): GraphQLError {
  return new GraphQLError(message, { extensions: { code: "BAD_USER_INPUT" } });
}

/** zod で検査する（MCP の道具の inputSchema と同じ定義を使う）。誤りは BAD_USER_INPUT で返す。 */
function parse<S extends z.ZodRawShape>(shape: S, input: Record<string, unknown>): z.infer<z.ZodObject<S>> {
  const r = z.object(shape).safeParse(input);
  if (!r.success) throw badInput(r.error.issues.map((i) => `${i.path.join(".") || "入力"}: ${i.message}`).join(" / "));
  return r.data;
}

/** 省略可の引数の null を「指定なし」にする（GraphQL の `field: null` と省略を同じに扱う）。 */
function dropNull<T extends Record<string, unknown>>(o: T): { [K in keyof T]: Exclude<T[K], null> } {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null && v !== undefined)) as { [K in keyof T]: Exclude<T[K], null> };
}

/**
 * service が投げた Error を、message つきで client に返す（yoga は素の Error を mask するので、MCP の `{ error }` と同じく
 * 理由を返すには GraphQLError にする）。extensions.code = OPERATION_FAILED。
 */
async function run<T>(fn: () => Promise<T> | T): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof GraphQLError) throw e;
    throw new GraphQLError(e instanceof Error ? e.message : String(e), { extensions: { code: "OPERATION_FAILED" } });
  }
}

/** 登録済みの session の端末だけ受ける（`/sessions/<n>/input|resize|attachments` の 404 と同じ）。 */
function requireTerminal(ctx: GraphqlContext, session: string): void {
  if (!ctx.services.core.has(session)) throw new GraphQLError("未定義の session", { extensions: { code: "NOT_FOUND" } });
}

const notRunning = (): GraphQLError => new GraphQLError("session が実行中でない", { extensions: { code: "OPERATION_FAILED" } });

export const mutationResolvers: Record<string, Resolver> = {
  createSession: (_p, args, { services }) =>
    run(async () => {
      const { name, path, settings } = parse(
        { name: sessionName, path: z.string().min(1).optional(), settings: projectSettingsPatchSchema.optional() },
        dropNull(args),
      );
      return services.sessions.create({ name, ...(path !== undefined ? { path } : {}), ...(settings !== undefined ? { settings } : {}) });
    }),

  updateSession: (_p, args, { services }) =>
    run(async () => {
      const input = parse(
        { name: sessionName, newName: sessionName.optional(), path: z.string().min(1).optional(), move: z.boolean().optional() },
        dropNull(args),
      );
      return services.sessions.update(input);
    }),

  // MCP の session_sleep と同じ入口（resession.requestSleep）。引継ぎを頼んで受理して即返す。断る時（作業中など）は理由つきの error（OPERATION_FAILED）
  sleepSession: (_p, args, { services }) =>
    run(async () => {
      const { name } = parse({ name: sessionName }, args);
      return services.resession.requestSleep(name);
    }),

  wakeSession: (_p, args, { services }) =>
    run(async () => {
      const { name } = parse({ name: sessionName }, args);
      return services.sessions.wake(name);
    }),

  updateSessionSettings: (_p, args, { services }) =>
    run(async () => {
      const { name, settings } = parse({ name: sessionName, settings: projectSettingsPatchSchema }, args);
      return (await services.sessions.updateSettings(name, settings)).settings;
    }),

  updateCenterSettings: (_p, args, { services }) =>
    run(async () => {
      const { settings } = parse({ settings: centerSettingsPatchSchema }, args);
      return (await services.sessions.updateCenterSettings(settings)).settings;
    }),

  startSessionLogin: (_p, args, { services }) =>
    run(async () => {
      const { name } = parse({ name: sessionName }, args);
      if (!services.login) throw new Error("再ログインは使えない（pty 入力が無い）");
      return services.login.start(name);
    }),

  // ok: false（コード不正・keychain のロック）は結果の ok / error で返す（error にしない）
  submitSessionLoginCode: (_p, args, { services }) =>
    run(async () => {
      const { name, code } = parse({ name: sessionName, code: z.string().regex(LOGIN_CODE, "英数字と # _ - のみ（512 文字まで）") }, args);
      if (!services.login) throw new Error("再ログインは使えない（pty 入力が無い）");
      return services.login.code(name, code);
    }),

  // 今の `rc_stop` → `rc_start(resume)` の 2 手と同じ（スリープ中は起こす）
  restartSession: (_p, args, { services }) =>
    run(async () => {
      const { name } = parse({ name: sessionName }, args);
      await services.supervisor.stop(name);
      if (services.sessions.list().some((s) => s.name === name && s.sleeping)) await services.sessions.wake(name);
      else await services.supervisor.start(name, { resume: true });
      return true;
    }),

  replyWorker: (_p, args, { services }) =>
    run(async () => {
      const input = parse(workerReplySchema, { remote_id: args.remoteId, server: args.server, worker_id: args.workerId, text: args.text });
      await services.remotes.workerReply(dropNull(input));
      return true;
    }),

  retireServer: (_p, args, { services }) =>
    run(async () => {
      const { serverId } = parse({ serverId: z.string().min(1) }, args);
      return retireServer({ link: services.link, remotes: services.remotes, log: services.log }, { server: serverId });
    }),

  terminalInput: (_p, args, ctx) =>
    run(() => {
      const { session, dataB64 } = parse({ session: sessionName, dataB64: z.string().min(1, "base64 文字列").regex(BASE64_STRICT, "base64 文字列") }, args);
      requireTerminal(ctx, session);
      if (!ctx.services.core.input(session, Buffer.from(dataB64, "base64"))) throw notRunning();
      return true;
    }),

  terminalResize: (_p, args, ctx) =>
    run(() => {
      const size = z.number().int().min(1).max(1000);
      const { session, cols, rows } = parse({ session: sessionName, cols: size, rows: size }, args);
      requireTerminal(ctx, session);
      if (!ctx.services.core.resize(session, cols, rows)) throw notRunning();
      return true;
    }),

  // POST /sessions/<n>/attachments と同じ検査・同じ保存（attachments.ts）。bytes は base64 で受ける（#7 の仮の入力）
  attachToSession: (_p, args, ctx) =>
    run(async () => {
      const { session, type: rawType, dataB64 } = parse({ session: sessionName, type: z.string(), dataB64: z.string() }, args);
      requireTerminal(ctx, session);
      const { workspace, log } = ctx.services;
      const refuse = (message: string): never => {
        log(`添付を拒否: session=${session} reason=${message}`);
        throw badInput(message);
      };
      if (!workspace) throw new Error("center に workspace が無い（config の workspace を設定する）");
      const type = mediaType(rawType);
      if (!ATTACHMENT_TYPES[type]) return refuse(`未対応の型: ${type || "(なし)"}（png / jpeg / gif / webp のみ）`);
      // 復号の前に大きさを見る（base64 は 4/3 倍）
      if (dataB64.length > Math.ceil(MAX_ATTACHMENT_BYTES / 3) * 4) return refuse(`1 枚 ${MAX_ATTACHMENT_BYTES / 1024 / 1024}MB まで`);
      if (!BASE64.test(dataB64)) return refuse("dataB64 は base64 文字列");
      const body = Buffer.from(dataB64, "base64");
      if (body.length > MAX_ATTACHMENT_BYTES) return refuse(`1 枚 ${MAX_ATTACHMENT_BYTES / 1024 / 1024}MB まで`);
      if (body.length === 0) return refuse("本文が空");
      if (!matchesMagic(type, body)) return refuse(`中身が ${type} の画像でない`);
      try {
        const saved = await saveAttachment({ workspace, session, type, body });
        log(`添付を保存: session=${session} bytes=${saved.bytes} path=${saved.path}`);
        return { path: saved.path, bytes: saved.bytes };
      } catch (e) {
        if (e instanceof AttachmentError) throw badInput(e.message);
        log(`添付の保存失敗: session=${session} ${e instanceof Error ? e.message : String(e)}`);
        throw new Error("保存に失敗した");
      }
    }),
};
