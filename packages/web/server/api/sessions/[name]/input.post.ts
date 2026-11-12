import { getCenterClient } from "../../../utils/center/client";
import { createInputHandler } from "../../../utils/terminal/handlers";

export default createInputHandler(() => getCenterClient());
