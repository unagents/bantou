import { getCenterClient } from "../../../utils/center/client";
import { createOutputHandler } from "../../../utils/terminal/handlers";

export default createOutputHandler(() => getCenterClient());
