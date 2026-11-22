// 作業指示（requirement）と仕様・設計（PGlite。docker 不要）
import { describe } from "node:test";
import { createTestDb } from "./helpers/fakes.ts";
import { defineRequirementSuite } from "./helpers/requirement-suite.ts";

describe("requirement / spec (PGlite)", () => defineRequirementSuite(createTestDb));
