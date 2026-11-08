// --config 省略時の config.json の場所を決める。
//   1. $BANTOU_HOME（無ければ $HOME）/config.json
//   2. 1 が無く、旧既定 $HOME/.config/bantou/config.json があればそれ（後方互換）
//   どちらも無ければ 1（読めないエラーの出力先として）
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export function resolveDefaultConfig({ env = process.env, home = homedir(), exists = existsSync } = {}) {
  const root = env.BANTOU_HOME && env.BANTOU_HOME.length > 0 ? resolve(env.BANTOU_HOME) : home;
  const primary = join(root, "config.json");
  if (exists(primary)) return primary;
  const legacy = join(home, ".config", "bantou", "config.json");
  return exists(legacy) ? legacy : primary;
}
