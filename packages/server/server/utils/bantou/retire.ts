import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  PROTOCOL_VERSION,
  RETIRE_EXIT_CODE,
  SERVER_ID_PATTERN,
  type RetireResultReply,
  type RetireServerCommand,
  type RetireService,
  type ServerCommand,
  type ServerIdentityFields,
  type ServerReply,
} from "@agent-hand/bantou-protocol";

/**
 * 退役の印（`<workspace>/server.retired`）。書いた後は、起動し直しても bantou.mjs が起動を断る（exit 75）。
 * 値（名前・内容）は bin/bantou.mjs と揃える（test が突き合わせる）。
 */
export const RETIRED_FILE = "server.retired";

/** 退役した server の終了コード。supervisor 子 → server.exit → launcher → process と伝わる。systemd unit の RestartPreventExitStatus と揃える。 */
export const EXIT_RETIRED = RETIRE_EXIT_CODE;

/** 返信を center が取りに来る（messenger の poll は 1 秒間隔）のを待ってから messenger を閉じる時間。 */
export const REPLY_GRACE_MS = 3000;

/** 受付停止の直後から、返信の有無によらず終了へ進める上限。返信の送信が詰まっても server が居座らない。 */
export const FINISH_DEADLINE_MS = 10_000;

/** shell 用の単一引用符 quote。 */
export function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export interface ServiceProbeEnv {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  /** /proc/self/cgroup の中身（linux）。読めなければ undefined。 */
  cgroup?: string;
}

const DEFAULT_UNIT = "bantou-server.service";
const DEFAULT_LABEL = "com.unagents.bantou";

/** 自分の process から、systemd / launchd で動いているかと unit 名・label を読む。名前が取れなければ install-service.sh の既定名（detected=false）。 */
export function detectService(p: ServiceProbeEnv): RetireService {
  if (p.platform === "linux") {
    if (!p.env.INVOCATION_ID) return { manager: "none" };
    const names = (p.cgroup ?? "").split("\n").flatMap((l) => l.split("/").filter((s) => /^[A-Za-z0-9@:._\\-]+\.service$/.test(s)));
    const name = names.at(-1);
    return name ? { manager: "systemd", name, detected: true } : { manager: "systemd", name: DEFAULT_UNIT, detected: false };
  }
  if (p.platform === "darwin") {
    const label = p.env.XPC_SERVICE_NAME;
    // launchd の job は XPC_SERVICE_NAME に label が入る。端末や GUI アプリは "0" や application.* になる
    if (!label || label === "0" || label.startsWith("application.")) return { manager: "none" };
    return /^[A-Za-z0-9._-]+$/.test(label) ? { manager: "launchd", name: label, detected: true } : { manager: "launchd", name: DEFAULT_LABEL, detected: false };
  }
  return { manager: "none" };
}

export interface HostStepsInput {
  service: RetireService;
  platform: NodeJS.Platform;
  user: string | undefined;
  /** 実行 user の HOME。workspace がこの下なら user 削除に含まれる。 */
  home: string | undefined;
  workspace: string;
}

/** 退役後に host で root が行う 1〜3 行（unit 削除 → user 削除 → workspace 削除）。値は shell quote する。 */
export function buildHostSteps(i: HostStepsInput): string[] {
  const steps: string[] = [];
  const s = i.service;
  if (s.manager === "systemd" && s.name) {
    const u = shQuote(s.name);
    steps.push(`sudo systemctl disable --now ${u} && sudo rm -f ${shQuote(`/etc/systemd/system/${s.name}`)} && sudo systemctl daemon-reload`);
  } else if (s.manager === "launchd" && s.name) {
    steps.push(`sudo launchctl bootout ${shQuote(`system/${s.name}`)}; sudo rm -f ${shQuote(`/Library/LaunchDaemons/${s.name}.plist`)}`);
  }
  // workspace が HOME そのもの、または配下なら user ごと消える（install-service.sh の構成: workspace = HOME）。安全のため "/" や短い path の rm -rf は出さない
  const under = i.home !== undefined && (i.workspace === i.home || i.workspace.startsWith(i.home.endsWith("/") ? i.home : `${i.home}/`));
  const hasUser = i.user !== undefined && i.user !== "root" && /^[A-Za-z_][A-Za-z0-9_.-]*$/.test(i.user);
  if (hasUser) {
    const del = i.platform === "darwin" ? `sudo sysadminctl -deleteUser ${shQuote(i.user!)}` : `sudo userdel ${under ? "-r " : ""}${shQuote(i.user!)}`;
    steps.push(del);
  }
  const safePath = i.workspace.split("/").filter(Boolean).length >= 2;
  if ((!hasUser || !under || i.platform === "darwin") && safePath) steps.push(`sudo rm -rf ${shQuote(i.workspace)}`);
  if (steps.length === 0) steps.push("# 自動で示せる手順が無い（user も安全な workspace path も特定できない）。workspace を確認して手で片付ける");
  return steps;
}

/** 退役中に断る指示の error。center には「退役中で、再送しても通らない」と分かるようにする。 */
export function retiringError(cmd: ServerCommand): ServerReply {
  const id =
    cmd.type === "task"
      ? { cap_id: cmd.cap_id, task_id: cmd.task_id }
      : cmd.type === "worker_reply"
        ? { cap_id: cmd.cap_id, worker_id: cmd.worker_id }
        : cmd.type === "kick_cap" || cmd.type === "stop_cap"
          ? { cap_id: cmd.cap_id }
          : cmd.type === "resume_worker"
            ? { worker_id: cmd.worker_id }
            : {};
  return {
    bantou: PROTOCOL_VERSION,
    type: "error",
    ok: false,
    message: "server は退役中のため受け付けない（再送しても通らない）",
    command: cmd.type,
    ...id,
    retryable: false,
    retiring: true,
  };
}

/** 退役中でも受け付ける指示（状態の照会と、実行中の停止）。 */
export function allowedWhileRetiring(cmd: ServerCommand): boolean {
  return cmd.type === "hello" || cmd.type === "status" || cmd.type === "stop_cap" || cmd.type === "retire_server";
}

export interface RetireDeps {
  workspace: string;
  identity: ServerIdentityFields;
  /** 今走っている cap / worker の数（停止前に数える）。 */
  count: () => { caps: number; workers: number };
  /** 更新の予約を取り消す（更新待機が退役後の idle で再起動を始めないように）。 */
  cancelUpdate: () => void;
  /** update.json（restart の合図）を消す。書かれていると supervisor が次の版を起動する。失敗は呼び出し側で log して続行。 */
  clearUpdateFile?: () => Promise<void>;
  /** 新しい task / worker_start / report を断る状態にする。 */
  refuse: () => void;
  /** 実行中の cap / worker を全部止める（既存の shutdown 経路）。 */
  stopAll: () => Promise<void>;
  /** messenger の登録解除・broker 停止・process 終了を頼む（exit code は daemon.exitCode()）。 */
  finish: () => void;
  service: () => RetireService;
  platform?: NodeJS.Platform;
  user?: string;
  home?: string;
  now?: () => Date;
  replyGraceMs?: number;
  finishDeadlineMs?: number;
  /** 退役の印の書込（test 差し替え）。 */
  writeMarker?: (workspace: string, body: Record<string, unknown>) => Promise<void>;
  log: (m: string) => void;
}

export interface RetireController {
  /** 退役の受付済みか（印を書いた後）。 */
  isRetiring(): boolean;
  /** 退役を実行して返信内容を作る。2 回目以降は同じ返信。失敗（宛先違い・印を書けない）は error で、何も止めない。 */
  request(cmd: RetireServerCommand, from: string): Promise<ServerReply>;
  /** 返信を送り終えた（失敗でも）後に呼ぶ。猶予の後で finish する。 */
  replied(): void;
}

/** 印を tmp に書いてから置く。 */
export async function writeRetiredMarker(workspace: string, body: Record<string, unknown>): Promise<void> {
  await mkdir(workspace, { recursive: true });
  const path = join(workspace, RETIRED_FILE);
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    await writeFile(tmp, JSON.stringify(body, null, 2) + "\n", { mode: 0o644 });
    await rename(tmp, path);
  } finally {
    await unlink(tmp).catch(() => {});
  }
}

/**
 * 退役の手順。順序（途中で失敗しても必ず finish まで進む。印を書けない時だけ、何も止めずに error で終える）:
 *  1. 宛先確認（server_id）  2. 印を書く  3. 受付停止（task / worker_start / report）と更新予約の取消  4. 数える
 *  5. cap / worker を止める  6. 返信を作る（呼び出し側が送る）  7. 返信後、猶予を置いて finish（messenger 登録解除 → 終了）
 * 6 を送れなくても 7 は deadline で必ず走る（居座らない）。
 */
export function createRetireController(deps: RetireDeps): RetireController {
  const { log } = deps;
  const now = deps.now ?? (() => new Date());
  const graceMs = deps.replyGraceMs ?? REPLY_GRACE_MS;
  const deadlineMs = deps.finishDeadlineMs ?? FINISH_DEADLINE_MS;
  const writeMarker = deps.writeMarker ?? writeRetiredMarker;
  let retiring = false;
  let reply: RetireResultReply | undefined;
  let inflight: Promise<ServerReply> | undefined;
  let finished = false;
  let graceTimer: ReturnType<typeof setTimeout> | undefined;
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;

  const finishOnce = (): void => {
    if (finished) return;
    finished = true;
    if (graceTimer) clearTimeout(graceTimer);
    if (deadlineTimer) clearTimeout(deadlineTimer);
    deps.finish();
  };

  const error = (message: string): ServerReply => ({ bantou: PROTOCOL_VERSION, type: "error", ok: false, message, command: "retire_server" });

  async function run(cmd: RetireServerCommand, from: string): Promise<ServerReply> {
    if (cmd.server_id !== undefined) {
      if (!SERVER_ID_PATTERN.test(cmd.server_id)) return error("server_id が不正");
      if (deps.identity.server_id !== undefined && cmd.server_id !== deps.identity.server_id) {
        log(`退役を拒否: 宛先違い 指定=${cmd.server_id} 自分=${deps.identity.server_id}`);
        return error(`宛先の server_id が違う（指定 ${cmd.server_id}、この server は ${deps.identity.server_id}）。何も止めていない`);
      }
    }
    const at = now();
    try {
      await writeMarker(deps.workspace, {
        retired_at: at.toISOString(),
        ...(deps.identity.server_id !== undefined ? { server_id: deps.identity.server_id } : {}),
        by: from,
        ...(cmd.reason !== undefined ? { reason: cmd.reason } : {}),
        note: "この file がある間、この workspace の bantou-server は起動しない（exit 75）。再び使うなら削除する",
      });
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      log(`退役を中止: ${RETIRED_FILE} を書けない: ${m}`);
      return error(`退役できない: ${RETIRED_FILE} を書けない（${m}）。何も止めていない`);
    }
    retiring = true;
    log(`退役を受け付けた: from=${from}${cmd.reason ? ` reason=${cmd.reason}` : ""}`);
    // 受付停止と更新の取消は、止める前に済ませる（止めて idle になった瞬間に更新が再起動を始めない／新しい worker が立たない）
    try {
      deps.cancelUpdate();
      deps.refuse();
    } catch (e) {
      log(`受付停止でエラー（続行）: ${e instanceof Error ? e.message : String(e)}`);
    }
    const clearUpdate = async (): Promise<void> => {
      try {
        await deps.clearUpdateFile?.();
      } catch (e) {
        log(`update.json を消せない（続行。supervisor も印を見て再起動しない）: ${e instanceof Error ? e.message : String(e)}`);
      }
    };
    await clearUpdate();
    // 返信の有無によらず終了へ進める（途中の失敗で居座らない）
    deadlineTimer = setTimeout(() => {
      log("退役の期限に達したため終了へ進む");
      finishOnce();
    }, deadlineMs);
    deadlineTimer.unref?.();
    let stopped = { caps: 0, workers: 0 };
    try {
      stopped = deps.count();
    } catch (e) {
      log(`実行中の数を取れない（続行）: ${e instanceof Error ? e.message : String(e)}`);
    }
    try {
      await deps.stopAll();
    } catch (e) {
      log(`cap / worker の停止でエラー（続行）: ${e instanceof Error ? e.message : String(e)}`);
    }
    // 取消の直前に書き込み中だった update.json が停止中に着地した場合に備え、もう一度消す
    await clearUpdate();
    const service = deps.service();
    const platform = deps.platform ?? process.platform;
    reply = {
      bantou: PROTOCOL_VERSION,
      type: "retire_result",
      ok: true,
      state: "retiring",
      ...deps.identity,
      stopped,
      exit_at: new Date(now().getTime() + graceMs).toISOString(),
      exit_code: EXIT_RETIRED,
      host_steps: buildHostSteps({ service, platform, user: deps.user ?? deps.identity.user, home: deps.home, workspace: deps.workspace }),
      service,
    };
    log(`退役: 停止 caps=${stopped.caps} workers=${stopped.workers}、${graceMs}ms 後に終了 (exit ${EXIT_RETIRED})`);
    return reply;
  }

  return {
    isRetiring: () => retiring,
    request(cmd, from) {
      if (reply) return Promise.resolve(reply);
      inflight ??= run(cmd, from).then((r) => {
        // 拒否（宛先違い・印を書けない）は退役していないので、覚えない（直した指示を受け付けられる）
        if (r.type === "error") inflight = undefined;
        return r;
      });
      return inflight;
    },
    replied() {
      if (!reply || graceTimer || finished) return;
      graceTimer = setTimeout(finishOnce, graceMs);
      graceTimer.unref?.();
    },
  };
}
