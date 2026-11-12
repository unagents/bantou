import { createGuardHandler, guardFromEnv } from "../utils/guard/handler";

export default createGuardHandler(() => guardFromEnv());
