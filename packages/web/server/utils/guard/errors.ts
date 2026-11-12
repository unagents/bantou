/** 守りの拒否。status をそのまま応答に使う。message に secret・token を入れない。 */
export class GuardError extends Error {
  constructor(
    readonly status: 401 | 403 | 500,
    readonly code: string,
  ) {
    super(code);
    this.name = "GuardError";
  }
}
