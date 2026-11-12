import { terminalService } from "../../../utils/center";
import { createResizeHandler } from "../../../utils/terminal/handlers";

export default createResizeHandler(() => terminalService());
