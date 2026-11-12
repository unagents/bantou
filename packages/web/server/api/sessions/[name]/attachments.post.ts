import { terminalService } from "../../../utils/center";
import { createAttachmentsHandler } from "../../../utils/terminal/handlers";

export default createAttachmentsHandler(() => terminalService());
