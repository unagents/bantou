// host-lock テスト用の子。argv[2]: hold（取って待つ）| guard（guardHostLock を呼び、取れたら即終了）。lock の場所は env BANTOU_SERVER_HOST_LOCK。
import { acquireHostLock, guardHostLock } from "../../bin/host-lock.mjs";

if (process.argv[2] === "hold") {
  const r = acquireHostLock({ info: { workspace: "/fixture/ws" } });
  if (!r.ok) {
    console.log("busy");
    process.exit(3);
  }
  // handler を先に入れてから held を出す（親が held を見て即 SIGTERM しても取りこぼさない）
  process.on("SIGTERM", () => {
    r.release();
    process.exit(0);
  });
  console.log("held");
  setInterval(() => {}, 1000);
} else {
  guardHostLock();
  console.log("acquired");
}
