import { terminalService } from "../../../utils/center";
import { createInputHandler } from "../../../utils/terminal/handlers";

export default createInputHandler(() => terminalService());
