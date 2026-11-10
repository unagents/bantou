// PGlite（WASM の本物の PostgreSQL + pgvector）で動かす統合 test。docker 不要
import { describe } from "node:test";
import { createTestDb } from "./helpers/fakes.ts";
import { defineIntegration } from "./helpers/suite.ts";

describe("integration (PGlite)", () => defineIntegration(createTestDb));
