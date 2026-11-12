import { defineEventHandler } from "h3";
import { getCenterClient } from "../utils/center/client";

export default defineEventHandler(() => getCenterClient().health());
