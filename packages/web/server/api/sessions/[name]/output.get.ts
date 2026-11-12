import { terminalService } from "../../../utils/center";
import { createOutputHandler } from "../../../utils/terminal/handlers";

export default createOutputHandler(() => terminalService());
