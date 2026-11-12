import { getCenterClient } from "../../../utils/center/client";
import { createAttachmentsHandler } from "../../../utils/terminal/handlers";

export default createAttachmentsHandler(() => getCenterClient());
