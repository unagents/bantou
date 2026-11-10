// docker の実 PostgreSQL（pgvector/pgvector:pg17）で動かす統合 test。docker が無ければ skip（理由を出す）
import { describe } from "node:test";
import { createDockerPgTestDb, dockerSkipReason } from "./helpers/pgdocker.ts";
import { defineIntegration } from "./helpers/suite.ts";

const reason = dockerSkipReason();
if (reason) console.log(`# integration (PostgreSQL in docker) skipped: ${reason}`);

describe("integration (PostgreSQL in docker)", { skip: reason ?? false }, () => defineIntegration(createDockerPgTestDb));
