// package.json は静的に import する（bun build --compile の binary は実行時に package.json を読めない。bundle に入れる）。
// tsc の emit は dist/ に平らに出る（dist/../package.json = 同じ package）。
import pkg from "../package.json" with { type: "json" };

/** center の版（package.json の version）。 */
export function packageVersion(): string {
  return (pkg as { version?: string }).version ?? "0.0.0";
}
