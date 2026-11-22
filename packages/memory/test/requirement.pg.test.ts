// 作業指示（requirement）と仕様・設計（docker の実 PostgreSQL。docker が無ければ skip）
import { describe } from "node:test";
import { createDockerPgTestDb, dockerSkipReason } from "./helpers/pgdocker.ts";
import { defineRequirementSuite } from "./helpers/requirement-suite.ts";

const reason = dockerSkipReason();
if (reason) console.log(`# requirement / spec (PostgreSQL in docker) skipped: ${reason}`);

describe("requirement / spec (PostgreSQL in docker)", { skip: reason ?? false }, () => defineRequirementSuite(createDockerPgTestDb));
