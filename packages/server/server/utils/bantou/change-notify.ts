import type { ChangeNotice } from "./change-runner";
import type { NotifyTarget } from "./change-store";

/**
 * change の通知（worker_report（change_id つき）/ change_progress）を center へ送る。
 * center は名前で覚え、送る時に messenger の今の peer id へ引く（center の再起動で peer id が変わる）。remote-cap の
 * 通知（reports.ts の centerOf）と同じ流儀だが、cap の記録には触れない。
 */
export interface ChangeNotifierDeps {
  /** 名前の peer（自分を除く）。 */
  resolvePeers?: (name: string) => Promise<ReadonlyArray<{ id: string; registered_at?: string }>>;
  send: (to: string, notice: ChangeNotice) => Promise<void>;
  log: (msg: string) => void;
}

export function createChangeNotifier(deps: ChangeNotifierDeps): (to: { notify_id: string; target?: NotifyTarget }, notice: ChangeNotice) => Promise<void> {
  return async (to, notice) => {
    const target = to.target;
    if (!target) {
      deps.log(`通知先の center が分からない: notify_id=${to.notify_id} type=${notice.type}`);
      return;
    }
    let id = target.id;
    if (target.name && deps.resolvePeers) {
      try {
        const peers = await deps.resolvePeers(target.name);
        if (peers.length > 0 && !peers.some((p) => p.id === target.id)) {
          id = [...peers].sort((x, y) => (y.registered_at ?? "").localeCompare(x.registered_at ?? ""))[0]!.id;
        }
      } catch (e) {
        deps.log(`center の peer を引けない（覚えている id へ送る）: name=${target.name} ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    await deps.send(id, notice);
  };
}
