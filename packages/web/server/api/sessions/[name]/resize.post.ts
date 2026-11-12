import { getCenterClient } from "../../../utils/center/client";
import { createResizeHandler } from "../../../utils/terminal/handlers";

export default createResizeHandler(() => getCenterClient());
